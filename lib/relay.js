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

/* ------------------------------------------------------------- 大模型翻译 */
/* 方舟和百炼都提供 OpenAI 兼容接口,所以同一个类两边都能用。
   中间结果做节流 + 缓存,否则一句话会被翻几十次,钱烧得莫名其妙。 */
class LLMTranslator {
  constructor(baseURL, apiKey, model){
    this.base = (baseURL || '').replace(/\/+$/, '');
    this.key = apiKey; this.model = model;
    this.cache = new Map(); this.busy = false; this.last = 0;
  }
  get ok(){ return !!(this.base && this.key && this.model); }
  async translate(text, { urgent = false } = {}){
    text = (text || '').trim();
    if (!text || !this.ok) return '';
    if (this.cache.has(text)) return this.cache.get(text);
    if (!urgent){
      if (this.busy) return null;                     // 已有请求在飞,这次跳过
      if (Date.now() - this.last < 600) return null;  // 节流
    }
    this.busy = true; this.last = Date.now();
    try {
      const r = await fetch(this.base + '/chat/completions', {
        method:'POST',
        headers:{ 'content-type':'application/json', authorization:'Bearer ' + this.key },
        body: JSON.stringify({
          model: this.model, temperature: 0.2, max_tokens: 512, stream: false,
          messages: [
            { role:'system', content:'你是同声传译员。把用户给的英文口语原样译成自然流畅的简体中文。'
              + '只输出译文本身,不要解释、不要引号、不要加任何前后缀。若输入是不完整的半句,就照半句译。' },
            { role:'user', content: text }
          ]
        })
      });
      if (!r.ok) throw new Error(r.status + ' ' + (await r.text()).slice(0, 200));
      const j = await r.json();
      const out = ((j.choices?.[0]?.message?.content) || '').trim();
      if (this.cache.size > 400) this.cache.clear();
      this.cache.set(text, out);
      return out;
    } catch (e){ console.error('[llm]', e.message); return ''; }
    finally { this.busy = false; }
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
export function startAliyun(cfg, send, onClose){
  const c = cfg.creds;
  const key = c.apiKey || ENV.ALIYUN_API_KEY;
  if (!key) return send({ type:'error', message:'没有填阿里云百炼 API Key' });

  const endpoint = safeWs(c.endpoint || ENV.ALIYUN_ENDPOINT, DEFAULTS.aliyunEndpoint);
  const model    = (c.model || ENV.ALIYUN_MODEL || DEFAULTS.aliyunModel).trim();
  const useLLM   = c.translateMode === 'llm';
  const tr = useLLM
    ? new LLMTranslator(safeHttp(c.llmBase, DEFAULTS.aliyunLLMBase), key, c.llmModel || DEFAULTS.aliyunLLMModel)
    : null;

  console.log('  ↳ 阿里云 %s · 模型 %s · 翻译 %s', endpoint, model, useLLM ? ('大模型 ' + tr.model) : '模型自带');

  const taskId = crypto.randomUUID();
  const up = new WebSocket(endpoint, {
    headers: { Authorization:'Bearer ' + key, 'X-DashScope-DataInspection':'enable' }
  });

  let started = false;
  const pending = [], seen = new Set();

  // 握手被拒时 ws 不走 'error' 而是 unexpected-response,这里才拿得到真实 HTTP 状态码
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
      if (tx.sentence_end){
        const id = String(tx.sentence_id);
        if (seen.has(id)) return;
        seen.add(id);
        send({ type:'final', src: tx.text || '', dst: (await tr.translate(tx.text, { urgent:true })) || '' });
      } else {
        const d = await tr.translate(tx.text);
        send({ type:'partial', src: tx.text || '', dst: d === null ? undefined : (d || '') });
      }
      return;
    }

    const zh = (out.translations || []).find(t => t.lang === (cfg.to || 'zh'));
    const pair = { src: tx.text || '', dst: zh?.text || '' };
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
      send({ type:'final', src: u.text, dst: (await tr.translate(u.text, { urgent:true })) || '' });
      lastPartialSrc = lastPartialDst = '';
    }

    const tail = us[us.length - 1];
    const partialSrc = tail && !tail.definite ? tail.text : (us.length ? '' : (r.text || ''));
    if (!partialSrc) return;
    if (partialSrc !== lastPartialSrc){
      lastPartialSrc = partialSrc;
      const d = await tr.translate(partialSrc);
      if (d !== null && d !== undefined) lastPartialDst = d;
    }
    send({ type:'partial', src: partialSrc, dst: lastPartialDst });
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
      session = null;
      console.log('[conn] %s 断开 · 收到 %d 帧音频(约 %ds)', who, frames, Math.round(frames * 0.04));
    });
    ws.on('error', e => console.error('[conn] 错误', e.message));
  });
  return wss;
}
