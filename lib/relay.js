/* ============================================================================
 * 中转核心 —— 本地 server.js 和 Vercel 函数 api/asr.js 共用同一份
 *
 * 浏览器不能直连阿里云 / 火山:两家的流式接口都用自定义 HTTP Header 鉴权
 * (Authorization / X-Api-*),而浏览器的 WebSocket 构造函数不允许设 Header。
 * 所以必须有这一层。顺带也避免了把 API Key 暴露在前端 JS 里。
 * ==========================================================================*/
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';

const ENV = process.env;

/* 默认接入点。地域 / 业务空间不同,地址就不同,所以全部可以在网页里覆盖。 */
export const DEFAULTS = {
  aliyunEndpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
  aliyunModel:    'gummy-realtime-v1',
  aliyunAsrModel: 'qwen-audio-3.1-asr-flash-streaming',
  aliyunLLMBase:  'https://dashscope.aliyuncs.com/compatible-mode/v1',
  aliyunLLMModel: 'qwen-flash',
  volcEndpoint:   'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
  arkBase:        'https://ark.cn-beijing.volces.com/api/v3',
  arkModel:       'doubao-seed-1-6-flash-250828'
};

const safeWs = (u, fb) => {
  const v = (u || '').trim(); if (!v) return fb;
  try { const x = new URL(v); return (x.protocol === 'ws:' || x.protocol === 'wss:') ? x.toString() : fb; }
  catch { return fb; }
};
const safeHttp = (u, fb) => {
  const v = (u || '').trim(); if (!v) return fb;
  try { const x = new URL(v);
    return (x.protocol === 'http:' || x.protocol === 'https:') ? x.toString().replace(/\/+$/, '') : fb; }
  catch { return fb; }
};

/* ------------------------------------------------------------- 语言检测 */
/* 统计 CJK 统一表意文字(0x4E00-0x9FFF)占比,超过阈值判定为中文,
   否则视为英文。简单快速,零依赖。 */
const CJK_RE = /[\u4E00-\u9FFF\u3400-\u4DBF]/g;
export function detectLang(text){
  if (!text) return 'en';
  const m = (text.match(CJK_RE) || []).length;
  return m / text.length > 0.25 ? 'zh' : 'en';
}

/* ------------------------------------------------------------- 大模型翻译 */
/* 方舟和百炼都提供 OpenAI 兼容接口,所以同一个类两边都能用。
   中间结果做节流 + 缓存,否则一句话会被翻几十次,钱烧得莫名其妙。
   支持双向翻译:en2zh(英→中) 和 zh2en(中→英)。 */
const PROMPTS = {
  en2zh: '你是同声传译员。把用户给的英文口语原样译成自然流畅的简体中文。'
    + '只输出译文本身,不要解释、不要引号、不要加任何前后缀。若输入是不完整的半句,就照半句译。',
  zh2en: 'You are a simultaneous interpreter. Translate the user\'s spoken Chinese into natural, fluent English. '
    + 'Output only the translation itself. No explanations, no quotation marks, no prefixes or suffixes. '
    + 'If the input is an incomplete sentence, translate it as is.'
};
const WORD_PROMPT = '你是词典助手。把用户给的单词或短语翻译成中文,只输出释义本身,不要例句、不要解释。多个义项用逗号分隔。';

class LLMTranslator {
  constructor(baseURL, apiKey, model){
    this.base = (baseURL || '').replace(/\/+$/, '');
    this.key = apiKey; this.model = model;
    this.cache = new Map(); this.busy = false; this.last = 0;
    this.wordBusy = false; this.wordLast = 0;
  }
  get ok(){ return !!(this.base && this.key && this.model); }
  async translate(text, { urgent = false, direction = 'en2zh' } = {}){
    text = (text || '').trim();
    if (!text || !this.ok) return '';
    const cacheKey = direction + '::' + text;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    if (!urgent){
      if (this.busy) return null;
      if (Date.now() - this.last < 600) return null;
    }
    this.busy = true; this.last = Date.now();
    try {
      const r = await fetch(this.base + '/chat/completions', {
        method:'POST',
        headers:{ 'content-type':'application/json', authorization:'Bearer ' + this.key },
        body: JSON.stringify({
          model: this.model, temperature: 0.2, max_tokens: 512, stream: false,
          messages: [
            { role:'system', content: PROMPTS[direction] || PROMPTS.en2zh },
            { role:'user', content: text }
          ]
        })
      });
      if (!r.ok) throw new Error(r.status + ' ' + (await r.text()).slice(0, 200));
      const j = await r.json();
      const out = ((j.choices?.[0]?.message?.content) || '').trim();
      if (this.cache.size > 400) this.cache.clear();
      this.cache.set(cacheKey, out);
      return out;
    } catch (e){ console.error('[llm]', e.message); return ''; }
    finally { this.busy = false; }
  }
  async translateWord(word, { urgent = false } = {}){
    word = (word || '').trim().toLowerCase();
    if (!word || !this.ok) return '';
    const cacheKey = 'word::' + word;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    if (!urgent){
      if (this.wordBusy) return null;
      if (Date.now() - this.wordLast < 300) return null;
    }
    this.wordBusy = true; this.wordLast = Date.now();
    try {
      const r = await fetch(this.base + '/chat/completions', {
        method:'POST',
        headers:{ 'content-type':'application/json', authorization:'Bearer ' + this.key },
        body: JSON.stringify({
          model: this.model, temperature: 0.1, max_tokens: 64, stream: false,
          messages: [
            { role:'system', content: WORD_PROMPT },
            { role:'user', content: word }
          ]
        })
      });
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      const out = ((j.choices?.[0]?.message?.content) || '').trim();
      if (this.cache.size > 400) this.cache.clear();
      this.cache.set(cacheKey, out);
      return out;
    } catch (e){ console.error('[llm-word]', e.message); return ''; }
    finally { this.wordBusy = false; }
  }
}

/* ==========================================================================
 * 链路 A:阿里云百炼
 *   翻译方式 model —— Gummy 自带翻译,识别+翻译一步到位(仅北京地域有 Gummy)
 *   翻译方式 llm   —— 只做识别,再交给百炼的大模型翻译(新加坡等地域用这个)
 *
 * 接入地址随地域 / 业务空间变化,所以不写死:
 *   北京通用      wss://dashscope.aliyuncs.com/api-ws/v1/inference
 *   新加坡通用    wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference
 *   业务空间专属  wss://{ws-xxx}.{region}.maas.aliyuncs.com/api-ws/v1/inference
 * 注意:地域、API Key、模型列表三者绑定,不能跨地域混用。
 * ========================================================================== */
function isQwenRealtimeModel(model){
  return /livetranslate|qwen.*realtime/i.test(model || '');
}

function startQwenRealtime(cfg, send, onClose){
  const c = cfg.creds;
  const key = c.apiKey || ENV.ALIYUN_API_KEY;
  if (!key) return send({ type:'error', message:'没有填阿里云百炼 API Key' });

  let endpoint = safeWs(c.endpoint || ENV.ALIYUN_ENDPOINT, DEFAULTS.aliyunEndpoint);
  const model = (c.model || ENV.ALIYUN_MODEL || DEFAULTS.aliyunModel).trim();

  if (endpoint && model) {
    try {
      const u = new URL(endpoint);
      if (!u.searchParams.has('model')) u.searchParams.set('model', model);
      // 实时同传模型走 /realtime;老配置里填的 /inference 自动纠正
      u.pathname = u.pathname.replace(/\/+$/, '').replace(/\/inference$/i, '/realtime');
      if (!/\/realtime$/i.test(u.pathname)) u.pathname = '/api-ws/v1/realtime';
      endpoint = u.toString();
    } catch {}
  }

  // 断句静音窗口直接决定翻译滞后多久:服务端要等一段语音"说完"才生成译文,
  // 连续说话时窗口越长,攒的段落越长,译文就越晚。默认 400ms、最高 500ms。
  const sil = Math.min(500, Math.max(300, Number(cfg.endSilence) || 400));
  console.log('  ↳ 阿里云 Qwen Realtime %s · 模型 %s · 目标语言 %s · 断句 %dms',
    endpoint, model, cfg.to || 'zh', sil);

  const up = new WebSocket(endpoint, {
    headers: { Authorization:'Bearer ' + key }
  });

  let started = false, updateSentAt = 0, fellBack = false;
  const pending = [];
  let curSrc = '', curDst = '';
  let tOpen = 0, firstSrc = false, firstDst = false;

  const sendAudio = buf => {
    if (up.readyState !== WebSocket.OPEN) return;
    const b64 = Buffer.isBuffer(buf) ? buf.toString('base64') : Buffer.from(buf).toString('base64');
    up.send(JSON.stringify({ type:'input_audio_buffer.append', audio: b64 }));
  };

  const reset = () => { curSrc = ''; curDst = ''; };

  /* ---- 并行 ASR:上栏原文用专用流式识别模型,边说边出字,不等同传模型 ----
     优先用最新的 3.1 流式识别(近场 VAD),不可用就降级 3.0,再不行回退同传模型识别。
     识别走百炼通用域名:业务空间专属域名(llm-xxx.maas)只服务实时对话模型,
     不提供 /api-ws/v1/inference 识别接口。 */
  const asrCandidates = [
    c.asrModel || ENV.ALIYUN_ASR_MODEL,
    DEFAULTS.aliyunAsrModel,
    'qwen-audio-3.0-asr-flash-streaming'
  ].filter(Boolean).map(s => String(s).trim())
   .filter((v, i, a) => a.indexOf(v) === i);
  let asrEndpoint = '';
  {
    const custom = (c.asrEndpoint || ENV.ALIYUN_ASR_ENDPOINT || '').trim();
    if (custom) asrEndpoint = safeWs(custom, '');
    else {
      try {
        const sg = /ap-southeast-1|singapore|dashscope-intl/i.test(endpoint);
        asrEndpoint = sg
          ? 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference'
          : 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
      } catch {}
    }
  }
  let asr = null, asrReady = false, asrDead = false, asrTaskId = '';
  const asrPending = [];
  let asrT0 = 0, asrFirst = false, lastAsrText = '', asrIdx = 0, asrLogAt = 0;

  const sendAsrAudio = buf => {
    if (!asr || asr.readyState !== WebSocket.OPEN) return;
    asr.send(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  };

  const connectAsr = () => {
    if (!asrEndpoint || asrIdx >= asrCandidates.length){
      if (!asrReady) console.warn('[asr] 全部识别模型不可用,上栏回退到同传模型识别');
      asrDead = true;
      return;
    }
    const name = asrCandidates[asrIdx];
    const ws = new WebSocket(asrEndpoint, { headers: { Authorization:'Bearer ' + key } });
    asr = ws;
    const taskId = asrTaskId = crypto.randomUUID();
    let asrStarted = false, movedOn = false;

    const next = why => {
      if (movedOn) return; movedOn = true;
      console.warn('[asr] %s 不可用(%s),尝试下一个识别模型…', name, why);
      asrIdx++;
      try { ws.close(); } catch {}
      setTimeout(connectAsr, 200);
    };

    ws.on('unexpected-response', (_q, res) => next('握手 HTTP ' + res.statusCode));

    ws.on('open', () => {
      asrT0 = Date.now();
      const parameters = { sample_rate: cfg.sampleRate || 16000, format: 'pcm' };
      if (/3\.1-asr/i.test(name)) parameters.vad_model = 'near_meeting_16k';
      else parameters.max_sentence_silence = Math.min(500, Math.max(200, Number(cfg.endSilence) || 400));
      ws.send(JSON.stringify({
        header: { action:'run-task', task_id: taskId, streaming:'duplex' },
        payload: { task_group:'audio', task:'asr', function:'recognition', model: name, parameters, input: {} }
      }));
    });

    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      const ev = m.header && m.header.event;

      if (ev === 'task-started'){
        asrStarted = true; asrReady = true;
        console.log('[asr] 就绪 · %s +%dms', name, Date.now() - asrT0);
        asrPending.splice(0).forEach(sendAsrAudio);
        return;
      }
      if (ev === 'task-failed'){
        asrReady = false;
        next(m.header?.error_message || m.header?.error_code || 'task-failed');
        return;
      }
      if (ev !== 'result-generated') return;

      const out = m.payload && m.payload.output || {};
      const sn = out.sentence || out.transcription;
      if (!sn || !sn.text) return;
      const text = String(sn.text);
      if (sn.sentence_end){
        console.log('[asr] 句子定稿 +%dms · %s', Date.now() - asrT0, text.slice(0, 60));
        lastAsrText = '';
        send({ type:'final-src', src: text, lang: cfg.from || 'en' });
        return;
      }
      if (text !== lastAsrText){
        lastAsrText = text;
        if (!asrFirst){ asrFirst = true; asrLogAt = Date.now(); console.log('[asr] 首个中间结果 +%dms · %s', Date.now() - asrT0, text.slice(0, 60)); }
        else if (Date.now() - asrLogAt > 300){
          asrLogAt = Date.now();
          console.log('[asr] 中间结果 +%dms · %s', Date.now() - asrT0, text.slice(0, 60));
        }
        send({ type:'partial', src: text, lang: cfg.from || 'en' });
      }
    });

    ws.on('error', e => {
      if (!asrStarted) next(e.message || '连接错误');
      else asrDead = true;
    });
    ws.on('close', () => {
      if (!asrStarted) next('连接被关闭');
      else asrDead = true;
      if (asr === ws) asr = null;
    });
  };
  connectAsr();

  const sendSessionUpdate = full => {
    updateSentAt = Date.now();
    const session = {
      output_modalities: ['text'],
      // 必须显式指定音色:实时接口的会话默认音色是 Omni 模型的 Chelsie,
      // 同传模型不支持它,不写就会报 "Voice 'Chelsie' is not supported"。
      voice: 'Tina',
      translation: { language: cfg.to || 'zh' }
    };
    if (full) session.audio = { input: { turn_detection: { type:'server_vad', silence_duration_ms: sil } } };
    up.send(JSON.stringify({ type:'session.update', session }));
  };

  up.on('unexpected-response', (_q, res) => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => send({ type:'error',
      message:'阿里云握手失败 HTTP ' + res.statusCode
        + ((res.statusCode === 401 || res.statusCode === 403)
            ? ' —— API Key 与接入地址的地域不一致,或 Key 无效' : '')
        + (body ? ' · ' + body.slice(0, 200) : '') }));
  });

  up.on('open', () => {
    tOpen = Date.now();
    sendSessionUpdate(true);
  });

  up.on('message', raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    const ev = m.type;

    if (ev === 'session.created') return;
    if (ev === 'session.updated'){
      started = true; send({ type:'ready' });
      pending.splice(0).forEach(sendAudio);
      return;
    }
    if (ev === 'error'){
      if (!fellBack && updateSentAt && Date.now() - updateSentAt < 3000){
        fellBack = true;
        console.warn('[qwen] session.update 被拒,退回默认会话配置:', m.error?.message || '');
        try { sendSessionUpdate(false); } catch {}
        return;
      }
      return send({ type:'error', message:'阿里云: ' + (m.error?.message || JSON.stringify(m.error || m).slice(0, 200)) });
    }
    if (ev === 'session.finished'){ try { up.close(); } catch {} return; }

    if (ev === 'input_audio_buffer.speech_started'){
      console.log('[qwen] 检测到说话 +%dms', Date.now() - tOpen);
      reset(); return;
    }
    if (ev === 'input_audio_buffer.speech_stopped'){
      console.log('[qwen] 说话结束(开始断句) +%dms', Date.now() - tOpen);
      return;
    }
    if (ev === 'response.created'){
      console.log('[qwen] 开始生成译文 +%dms', Date.now() - tOpen);
      return;
    }

    /* 原文实时流式;译文只在完成后一次性下发,上下两栏互不等待。
       ASR 健康时上栏由并行识别流负责,同传模型的识别事件只在回退时使用。 */
    if (ev === 'conversation.item.input_audio_transcription.delta'){
      if (!asrDead) return;
      if (!firstSrc){ firstSrc = true; console.log('[qwen] ⚠ 上栏识别为回退模式(并行ASR不可用) 首个增量 +%dms', Date.now() - tOpen); }
      curSrc += m.delta || '';
      return send({ type:'partial', src: curSrc, lang: cfg.from || 'en' });
    }
    if (ev === 'conversation.item.input_audio_transcription.completed'){
      if (!asrDead) return;
      console.log('[qwen] 原文识别完成 +%dms', Date.now() - tOpen);
      const src = m.transcript || curSrc;
      curSrc = '';
      if (src) send({ type:'final-src', src, lang: cfg.from || 'en' });
      return;
    }
    if (ev === 'response.text.delta' || ev === 'response.audio_transcript.delta'){
      if (!firstDst){ firstDst = true; console.log('[qwen] 首个译文增量 +%dms', Date.now() - tOpen); }
      curDst += m.delta || '';
      return;
    }
    if (ev === 'response.text.done' || ev === 'response.audio_transcript.done'){
      console.log('[qwen] 译文完成 +%dms', Date.now() - tOpen);
      const dst = m.text || m.transcript || curDst;
      curDst = '';
      if (dst) send({ type:'final-dst', dst, lang: cfg.to || 'zh' });
      return;
    }
    if (ev === 'response.done'){
      console.log('[qwen] 本次响应结束 +%dms', Date.now() - tOpen);
      if (curDst){
        send({ type:'final-dst', dst: curDst, lang: cfg.to || 'zh' });
        curDst = '';
      }
      return;
    }
  });

  up.on('error', e => send({ type:'error', message:'阿里云连接失败: ' + e.message }));
  up.on('close', () => { try { asr && asr.close(); } catch {} onClose(); });

  return {
    audio(buf){
      if (!asrDead && asr){
        if (asrReady) sendAsrAudio(buf);
        else { if (asrPending.length < 100) asrPending.push(buf); }
      }
      if (up.readyState !== WebSocket.OPEN) return;
      if (!started){ if (pending.length < 300) pending.push(buf); return; }
      sendAudio(buf);
    },
    stop(){
      try {
        if (up.readyState === WebSocket.OPEN)
          up.send(JSON.stringify({ type:'session.finish' }));
      } catch {}
      try {
        if (asr && asr.readyState === WebSocket.OPEN)
          asr.send(JSON.stringify({ header:{ action:'finish-task', task_id: asrTaskId || crypto.randomUUID(), streaming:'duplex' },
                                    payload:{ input:{} } }));
      } catch {}
      setTimeout(() => {
        try{ up.close(); }catch{}
        try{ asr && asr.close(); }catch{}
      }, 3000);
    }
  };
}

export function startAliyun(cfg, send, onClose){
  const model = (cfg.creds.model || ENV.ALIYUN_MODEL || DEFAULTS.aliyunModel || '').trim();
  if (isQwenRealtimeModel(model)) return startQwenRealtime(cfg, send, onClose);

  const c = cfg.creds;
  const key = c.apiKey || ENV.ALIYUN_API_KEY;
  if (!key) return send({ type:'error', message:'没有填阿里云百炼 API Key' });

  let endpoint = safeWs(c.endpoint || ENV.ALIYUN_ENDPOINT, DEFAULTS.aliyunEndpoint);
  try {
    const u = new URL(endpoint);
    u.pathname = u.pathname.replace(/\/+$/, '').replace(/\/realtime$/i, '/inference');
    if (!/\/inference$/i.test(u.pathname)) u.pathname = '/api-ws/v1/inference';
    endpoint = u.toString();
  } catch {}
  const useLLM   = c.translateMode === 'llm';
  const tr = new LLMTranslator(safeHttp(c.llmBase, DEFAULTS.aliyunLLMBase), key, c.llmModel || DEFAULTS.aliyunLLMModel);

  console.log('  ↳ 阿里云 %s · 模型 %s · 翻译 %s', endpoint, model, useLLM ? ('大模型 ' + tr.model) : '模型自带+LLM双向');

  const taskId = crypto.randomUUID();
  const up = new WebSocket(endpoint, {
    headers: { Authorization:'Bearer ' + key, 'X-DashScope-DataInspection':'enable' }
  });

  let started = false;
  const pending = [], seen = new Set();

  up.on('unexpected-response', (_q, res) => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => send({ type:'error',
      message:'阿里云握手失败 HTTP ' + res.statusCode
        + ((res.statusCode === 401 || res.statusCode === 403)
            ? ' —— API Key 与接入地址的地域不一致,或 Key 无效' : '')
        + (body ? ' · ' + body.slice(0, 200) : '') }));
  });

  up.on('open', () => {
    up.send(JSON.stringify({
      header: { action:'run-task', task_id: taskId, streaming:'duplex' },
      payload: {
        task_group:'audio', task:'asr', function:'recognition', model,
        parameters: {
          sample_rate: cfg.sampleRate || 16000,
          format: 'pcm',
          source_language: cfg.from || 'en',
          transcription_enabled: true,
          translation_enabled: !useLLM,
          ...(useLLM ? {} : { translation_target_languages: [ cfg.to || 'zh' ] }),
          max_end_silence: cfg.endSilence || 800,
          ...(c.vocabularyId ? { vocabulary_id: c.vocabularyId } : {})
        },
        input: {}
      }
    }));
  });

  up.on('message', async raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    const h = m.header || {}, ev = h.event;

    if (ev === 'task-started'){
      started = true; send({ type:'ready' });
      pending.splice(0).forEach(b => up.send(b));
      return;
    }
    if (ev === 'task-failed'){
      let msg = h.error_message || h.error_code || '任务失败';
      if (/model|not.*(exist|found|support)/i.test(msg))
        msg += ' —— 该地域可能没有这个模型(Gummy 只在北京地域提供),换模型或换地域';
      return send({ type:'error', message:'阿里云: ' + msg });
    }
    if (ev === 'task-finished'){ try{ up.close(); }catch{} return; }
    if (ev !== 'result-generated') return;

    const out = m.payload?.output || {};
    const tx = out.transcription;
    if (!tx) return;

    if (useLLM){
      const srcLang = detectLang(tx.text);
      const direction = srcLang === 'zh' ? 'zh2en' : 'en2zh';
      if (tx.sentence_end){
        const id = String(tx.sentence_id);
        if (seen.has(id)) return;
        seen.add(id);
        send({ type:'final', src: tx.text || '', dst: (await tr.translate(tx.text, { urgent:true, direction })) || '', lang: srcLang });
      } else {
        const d = await tr.translate(tx.text, { direction });
        send({ type:'partial', src: tx.text || '', dst: d === null ? undefined : (d || ''), lang: srcLang });
      }
      return;
    }

    const srcLang = detectLang(tx.text);
    let dst = '';
    if (srcLang === 'zh'){
      if (tx.sentence_end){
        dst = (await tr.translate(tx.text, { urgent:true, direction:'zh2en' })) || '';
      } else {
        const d = await tr.translate(tx.text, { direction:'zh2en' });
        dst = d === null ? undefined : (d || '');
      }
    } else {
      dst = (out.translations || []).find(t => t.lang === (cfg.to || 'zh'))?.text || '';
    }
    const pair = { src: tx.text || '', dst, lang: srcLang };
    if (tx.sentence_end){
      const id = String(tx.sentence_id);
      if (seen.has(id)) return;
      seen.add(id);
      send({ type:'final', ...pair });
    } else send({ type:'partial', ...pair });
  });

  up.on('error', e => send({ type:'error', message:'阿里云连接失败: ' + e.message }));
  up.on('close', () => onClose());

  return {
    audio(buf){
      if (up.readyState !== WebSocket.OPEN) return;
      if (!started){ if (pending.length < 300) pending.push(buf); return; }
      up.send(buf);
    },
    stop(){
      try {
        if (up.readyState === WebSocket.OPEN)
          up.send(JSON.stringify({ header:{ action:'finish-task', task_id: taskId, streaming:'duplex' },
                                   payload:{ input:{} } }));
      } catch {}
      setTimeout(() => { try{ up.close(); }catch{} }, 800);
    }
  };
}

/* ==========================================================================
 * 链路 B:火山引擎 大模型流式识别 + 方舟豆包翻译
 *
 * 二进制帧格式(每包 = 4 字节头 [+ 4 字节 sequence] + 4 字节长度 + payload):
 *   byte0  高4位 协议版本(0b0001) | 低4位 头长度(0b0001 = 4 字节)
 *   byte1  高4位 消息类型          | 低4位 flags
 *          消息类型: 0b0001 客户端完整请求 / 0b0010 音频包
 *                    0b1001 服务端完整响应 / 0b1011 ACK / 0b1111 错误
 *          flags:    0b0000 无序号 / 0b0001 正序号 / 0b0010 末包 / 0b0011 末包带序号
 *   byte2  高4位 序列化(0b0001 JSON / 0b0000 raw) | 低4位 压缩(0b0001 gzip / 0b0000 无)
 *   byte3  保留 0x00
 * ========================================================================== */
const MT = { CLIENT_FULL:0b0001, AUDIO:0b0010, SERVER_FULL:0b1001, SERVER_ACK:0b1011, SERVER_ERR:0b1111 };

export function vPack(type, flags, ser, comp, payload){
  const len = Buffer.alloc(4); len.writeUInt32BE(payload.length, 0);
  return Buffer.concat([ Buffer.from([ 0x11, (type << 4) | flags, (ser << 4) | comp, 0x00 ]), len, payload ]);
}

export function vParse(buf){
  if (buf.length < 8) return null;
  const headSize = (buf[0] & 0x0f) * 4;
  const type  = (buf[1] >> 4) & 0x0f, flags = buf[1] & 0x0f;
  const ser   = (buf[2] >> 4) & 0x0f, comp  = buf[2] & 0x0f;
  let off = headSize;
  if (flags & 0b0001) off += 4;                       // 带 sequence
  if (type === MT.SERVER_ERR){
    const code = buf.readUInt32BE(off); off += 4;
    const size = buf.readUInt32BE(off); off += 4;
    let body = buf.slice(off, off + size);
    if (comp === 1) { try { body = zlib.gunzipSync(body); } catch {} }
    return { type, error: code, text: body.toString('utf8') };
  }
  const size = buf.readUInt32BE(off); off += 4;
  let body = buf.slice(off, off + size);
  if (comp === 1) { try { body = zlib.gunzipSync(body); } catch {} }
  let json = null;
  if (ser === 1 || body[0] === 0x7b){
    const s = body.toString('utf8'); const i = s.indexOf('{');
    if (i >= 0) { try { json = JSON.parse(s.slice(i)); } catch {} }
  }
  return { type, json };
}

export function startVolc(cfg, send, onClose){
  const c = cfg.creds;
  const appId = c.appId || ENV.VOLC_APP_ID;
  const token = c.accessToken || ENV.VOLC_ACCESS_TOKEN;
  const resId = c.resourceId || ENV.VOLC_RESOURCE_ID || 'volc.bigasr.sauc.duration';
  if (!appId || !token) return send({ type:'error', message:'没有填火山引擎 App ID / Access Token' });

  const endpoint = safeWs(c.endpoint || ENV.VOLC_ENDPOINT, DEFAULTS.volcEndpoint);
  const tr = new LLMTranslator(safeHttp(c.arkBase, DEFAULTS.arkBase),
                               c.arkKey || ENV.ARK_API_KEY,
                               c.arkModel || ENV.ARK_MODEL || DEFAULTS.arkModel);
  console.log('  ↳ 火山 %s · 资源 %s · 翻译 %s', endpoint, resId, tr.ok ? tr.model : '(未配置)');
  if (!tr.ok) send({ type:'error', message:'提示:没填方舟 API Key,只会出英文识别,不出译文' });

  const up = new WebSocket(endpoint, {
    headers: {
      'X-Api-App-Key':     appId,
      'X-Api-Access-Key':  token,
      'X-Api-Resource-Id': resId,
      'X-Api-Connect-Id':  crypto.randomUUID()
    }
  });

  let ready = false;
  const pending = [], doneKeys = new Set();
  let lastPartialSrc = '', lastPartialDst = '';

  up.on('unexpected-response', (_q, res) => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => send({ type:'error',
      message:'火山握手失败 HTTP ' + res.statusCode
        + ((res.statusCode === 401 || res.statusCode === 403)
            ? ' —— App ID / Access Token / Resource ID 三者有一个不对' : '')
        + (body ? ' · ' + body.slice(0, 200) : '') }));
  });

  up.on('open', () => {
    const payload = Buffer.from(JSON.stringify({
      user:  { uid: 'web-si' },
      audio: { format:'pcm', codec:'raw', rate: cfg.sampleRate || 16000, bits:16, channel:1 },
      request: {
        model_name:'bigmodel',
        language: c.language || 'en-US',
        enable_itn: true, enable_punc: true, enable_ddc: false,
        show_utterances: true,
        vad: { vad_enable: true, end_window_size: cfg.endSilence || 800 }
      }
    }), 'utf8');
    up.send(vPack(MT.CLIENT_FULL, 0b0000, 1, 0, payload));
    ready = true;
    send({ type:'ready' });
    pending.splice(0).forEach(b => up.send(b));
  });

  up.on('message', async raw => {
    const m = vParse(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
    if (!m) return;
    if (m.type === MT.SERVER_ERR)
      return send({ type:'error', message:'火山引擎 ' + m.error + ': ' + (m.text || '').slice(0, 200) });
    if (!m.json) return;

    const r = m.json.result || {}, us = r.utterances || [];

    for (const u of us){
      if (!u.definite) continue;
      const k = u.start_time + '|' + u.end_time + '|' + u.text;
      if (doneKeys.has(k)) continue;
      doneKeys.add(k);
      if (doneKeys.size > 500) doneKeys.clear();
      const srcLang = detectLang(u.text);
      const direction = srcLang === 'zh' ? 'zh2en' : 'en2zh';
      send({ type:'final', src: u.text, dst: (await tr.translate(u.text, { urgent:true, direction })) || '', lang: srcLang });
      lastPartialSrc = lastPartialDst = '';
    }

    const tail = us[us.length - 1];
    const partialSrc = tail && !tail.definite ? tail.text : (us.length ? '' : (r.text || ''));
    if (!partialSrc) return;
    const partialLang = detectLang(partialSrc);
    const partialDir = partialLang === 'zh' ? 'zh2en' : 'en2zh';
    if (partialSrc !== lastPartialSrc){
      lastPartialSrc = partialSrc;
      const d = await tr.translate(partialSrc, { direction: partialDir });
      if (d !== null && d !== undefined) lastPartialDst = d;
    }
    send({ type:'partial', src: partialSrc, dst: lastPartialDst, lang: partialLang });
  });

  up.on('error', e => send({ type:'error', message:'火山引擎连接失败: ' + e.message }));
  up.on('close', () => onClose());

  return {
    audio(buf){
      const pkt = vPack(MT.AUDIO, 0b0000, 0, 0, buf);
      if (up.readyState !== WebSocket.OPEN){ if (pending.length < 300) pending.push(pkt); return; }
      if (!ready){ pending.push(pkt); return; }
      up.send(pkt);
    },
    stop(){
      try {
        if (up.readyState === WebSocket.OPEN)
          up.send(vPack(MT.AUDIO, 0b0010, 0, 0, Buffer.alloc(0)));   // flags 0b0010 = 末包
      } catch {}
      setTimeout(() => { try{ up.close(); }catch{} }, 800);
    }
  };
}

/* ==========================================================================
 * 把中转逻辑挂到一个 WebSocketServer 上。
 * 本地 server.js 和 Vercel 的 api/asr.js 都调这一个函数。
 * ========================================================================== */
const START = { aliyun: startAliyun, volc: startVolc };

const buildCfg = m => ({
  provider:   m.provider,
  sampleRate: Number(m.sampleRate) || 16000,
  from: m.from || 'en', to: m.to || 'zh',
  endSilence: Math.min(3000, Math.max(200, Number(m.endSilence) || 800)),
  creds: m.creds || {}
});

export function attachRelay(wss){
  wss.on('connection', (ws, req) => {
    const who = (req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '?')
                  .split(',')[0].trim();
    let session = null, closed = false, frames = 0;
    let wordTr = null;

    const send = o => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };
    const bye  = () => { if (!closed){ closed = true; try{ ws.close(1000); }catch{} } };

    console.log('[conn] %s 接入', who);

    ws.on('message', (data, isBinary) => {
      if (isBinary){
        frames++;
        if (session) session.audio(Buffer.isBuffer(data) ? data : Buffer.from(data));
        return;
      }
      let m; try { m = JSON.parse(data.toString()); } catch { return; }

      /* ---- 单词翻译:前端悬停单词时请求 ---- */
      if (m.type === 'word-translate'){
        const word = (m.word || '').trim();
        if (!word) return send({ type:'word-result', word, translation:'' });
        if (!wordTr) return send({ type:'word-result', word, translation:'' });
        wordTr.translateWord(word, { urgent:true }).then(t => {
          send({ type:'word-result', word, translation: t || '' });
        });
        return;
      }

      if (m.type === 'zh2en-translate'){
        const text = (m.text || '').trim();
        if (!text) return send({ type:'zh2en-result', translation:'' });
        if (!wordTr) return send({ type:'zh2en-result', translation:'' });
        wordTr.translate(text, { urgent:true, direction:'zh2en' }).then(t => {
          send({ type:'zh2en-result', translation: t || '' });
        });
        return;
      }

      /* ---- 测试连接:只做握手 + run-task,拿到结果就断,不送音频 ---- */
      if (m.type === 'probe'){
        const cfg = buildCfg(m), fn = START[cfg.provider];
        if (!fn) return send({ type:'probe-result', ok:false, message:'未知的服务商' });
        console.log('[conn] %s 测试连接 · %s', who, cfg.provider);
        let done = false, probe = null;
        const finish = (ok, message) => {
          if (done) return; done = true;
          clearTimeout(timer);
          send({ type:'probe-result', ok, message });
          try { probe?.stop(); } catch {}
        };
        const timer = setTimeout(() => finish(false, '超时,10 秒内没有拿到响应'), 10000);
        probe = fn(cfg, o => {
          if (o.type === 'ready') finish(true, '连接成功,鉴权和模型都没问题');
          else if (o.type === 'error') finish(false, o.message);
        }, () => finish(false, '连接被上游关闭'));
        return;
      }

      if (m.type === 'start'){
        if (session) return;
        const cfg = buildCfg(m), fn = START[cfg.provider];
        console.log('[conn] %s 开始 · %s · 断句 %dms', who, cfg.provider, cfg.endSilence);
        if (!fn) return send({ type:'error', message:'未知的服务商: ' + cfg.provider });

        /* 为单词翻译创建独立的 LLM 翻译器 */
        const creds = m.creds || {};
        if (cfg.provider === 'aliyun'){
          const key = creds.apiKey || ENV.ALIYUN_API_KEY;
          if (key) wordTr = new LLMTranslator(
            safeHttp(creds.llmBase, DEFAULTS.aliyunLLMBase), key,
            creds.llmModel || DEFAULTS.aliyunLLMModel);
        } else if (cfg.provider === 'volc'){
          const key = creds.arkKey || ENV.ARK_API_KEY;
          if (key) wordTr = new LLMTranslator(
            safeHttp(creds.arkBase, DEFAULTS.arkBase), key,
            creds.arkModel || ENV.ARK_MODEL || DEFAULTS.arkModel);
        }

        try { session = fn(cfg, send, bye); }
        catch (e){
          console.error('[conn] 启动失败', e);
          send({ type:'error', message:'中转启动失败: ' + e.message });
        }
        return;
      }

      if (m.type === 'stop'){ session?.stop(); session = null; }
    });

    ws.on('close', () => {
      closed = true;
      try { session?.stop(); } catch {}
      session = null; wordTr = null;
      console.log('[conn] %s 断开 · 收到 %d 帧音频(约 %ds)', who, frames, Math.round(frames * 0.04));
    });
    ws.on('error', e => console.error('[conn] 错误', e.message));
  });
  return wss;
}
