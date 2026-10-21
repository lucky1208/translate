/* ============================================================================
 * 本地 / 自建服务器入口
 *   1) 发网页(public/)
 *   2) 当 WebSocket 中转:浏览器 ──> 本服务 ──> 阿里云百炼 / 火山引擎
 *
 * 中转逻辑在 lib/relay.js,和 Vercel 的 api/asr.js 共用同一份。
 *
 * 启动:  node server.js        (Windows 双击 start.bat)
 * 环境变量全部可选,网页里填了就以网页为准:
 *   PORT=8787
 *   ALIYUN_API_KEY=  ALIYUN_ENDPOINT=  ALIYUN_MODEL=
 *   VOLC_APP_ID=  VOLC_ACCESS_TOKEN=  VOLC_RESOURCE_ID=  VOLC_ENDPOINT=
 *   ARK_API_KEY=  ARK_MODEL=
 *   TLS_CERT=/path/fullchain.pem  TLS_KEY=/path/privkey.pem   # 填了就起 https
 * ==========================================================================*/
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { attachRelay } from './lib/relay.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const PUB  = path.join(__dirname, 'public');
const ENV  = process.env;
const HIST_DIR = path.join(__dirname, 'data');
const HIST_LIVE = path.join(HIST_DIR, 'hist-live.json');
const HIST_ZH2EN = path.join(HIST_DIR, 'hist-zh2en.json');

function readHist(file){
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}
function writeHist(file, arr){
  try {
    if (!fs.existsSync(HIST_DIR)) fs.mkdirSync(HIST_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(arr, null, 0), 'utf8');
  } catch (e){ console.error('[hist] write failed', e.message); }
}

/* ---------------------------------------------------------------- 静态服务 */
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.webmanifest':'application/manifest+json; charset=utf-8',
  '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon',
  '.woff2':'font/woff2', '.txt':'text/plain; charset=utf-8' };

function serve(req, res){
  if (req.url === '/healthz'){ res.writeHead(200); return res.end('ok'); }

  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/hist' && req.method === 'GET'){
    const scope = url.searchParams.get('scope');
    res.writeHead(200, { 'content-type':'application/json; charset=utf-8', 'access-control-allow-origin':'*' });
    return res.end(JSON.stringify({
      live:  scope === 'zh2en' ? [] : readHist(HIST_LIVE),
      zh2en: scope === 'live'  ? [] : readHist(HIST_ZH2EN)
    }));
  }
  if (url.pathname === '/api/hist/live/append' && req.method === 'POST'){
    let body='';
    req.on('data', d=>body+=d);
    req.on('end', ()=>{
      try {
        const rows = JSON.parse(body);
        const all = readHist(HIST_LIVE);
        if (Array.isArray(rows)) all.push(...rows);
        writeHist(HIST_LIVE, all);
        res.writeHead(200, { 'content-type':'application/json', 'access-control-allow-origin':'*' });
        res.end('{"ok":true,"count":' + all.length + '}');
      } catch { res.writeHead(400); res.end('bad json'); }
    });
    return;
  }
  if (url.pathname === '/api/hist/delete' && req.method === 'POST'){
    let body='';
    req.on('data', d=>body+=d);
    req.on('end', ()=>{
      try {
        const m = JSON.parse(body || '{}');
        const file = m.scope === 'zh2en' ? HIST_ZH2EN : HIST_LIVE;
        const row = m.row || {};
        const arr = readHist(file);
        const eq = (a,b) => String(a||'') === String(b||'');
        let i = arr.findIndex(r =>
          eq(r.src, row.src) && eq(r.dst, row.dst) &&
          (row.t != null ? r.t === row.t : r.time === row.time));
        if (i < 0) i = arr.findIndex(r => eq(r.src, row.src) && eq(r.dst, row.dst));
        if (i >= 0) arr.splice(i, 1);
        writeHist(file, arr);
        res.writeHead(200, { 'content-type':'application/json', 'access-control-allow-origin':'*' });
        res.end(JSON.stringify({ ok: i >= 0, count: arr.length }));
      } catch { res.writeHead(400); res.end('bad json'); }
    });
    return;
  }
  if (url.pathname === '/api/hist/live' && req.method === 'POST'){
    let body='';
    req.on('data', d=>body+=d);
    req.on('end', ()=>{
      try {
        const arr = JSON.parse(body);
        writeHist(HIST_LIVE, arr);
        res.writeHead(200, { 'content-type':'application/json', 'access-control-allow-origin':'*' });
        res.end('{"ok":true}');
      } catch { res.writeHead(400); res.end('bad json'); }
    });
    return;
  }
  if (url.pathname === '/api/hist/zh2en' && req.method === 'POST'){
    let body='';
    req.on('data', d=>body+=d);
    req.on('end', ()=>{
      try {
        const arr = JSON.parse(body);
        writeHist(HIST_ZH2EN, arr);
        res.writeHead(200, { 'content-type':'application/json', 'access-control-allow-origin':'*' });
        res.end('{"ok":true}');
      } catch { res.writeHead(400); res.end('bad json'); }
    });
    return;
  }
  if (url.pathname === '/api/hist' && req.method === 'DELETE'){
    try { fs.unlinkSync(HIST_LIVE); fs.unlinkSync(HIST_ZH2EN); } catch {}
    res.writeHead(200, { 'access-control-allow-origin':'*' });
    return res.end('{"ok":true}');
  }

  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(PUB, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUB)){ res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (e, buf) => {
    if (e){ res.writeHead(404, {'content-type':'text/plain; charset=utf-8'}); return res.end('404'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream',
                         'cache-control':'no-cache' });
    res.end(buf);
  });
}

const server = (ENV.TLS_CERT && ENV.TLS_KEY)
  ? https.createServer({ cert: fs.readFileSync(ENV.TLS_CERT), key: fs.readFileSync(ENV.TLS_KEY) }, serve)
  : http.createServer(serve);

/* WebSocket 端点。/api/asr 是为了和 Vercel 上的路径保持一致,
   /asr 保留兼容老配置 —— 两个都能连,前端默认用 /api/asr。 */
const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
attachRelay(wss);

const WS_PATHS = new Set(['/api/asr', '/asr']);
server.on('upgrade', (req, socket, head) => {
  const p = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';
  if (!WS_PATHS.has(p)){ socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

/* --------------------------------------------------------------------- 启动 */
server.listen(PORT, '0.0.0.0', () => {
  const proto = (ENV.TLS_CERT && ENV.TLS_KEY) ? 'https' : 'http';
  console.log('');
  console.log('  同声传译服务已启动');
  console.log('  ------------------------------------------------');
  console.log('  本机打开:   %s://localhost:%d', proto, PORT);
  for (const list of Object.values(os.networkInterfaces()))
    for (const n of list || [])
      if (n.family === 'IPv4' && !n.internal)
        console.log('  局域网地址: %s://%s:%d', proto, n.address, PORT);
  if (proto === 'http')
    console.log('\n  ⚠ 手机 / 其它电脑通过 IP 访问时,浏览器会拒绝使用麦克风。');
  console.log('    麦克风只在 https 或 localhost 下可用,详见 README。');
  console.log('  ------------------------------------------------');
  console.log('  预置密钥: 阿里云 %s · 火山 %s · 方舟 %s',
    ENV.ALIYUN_API_KEY ? '有' : '无',
    (ENV.VOLC_APP_ID && ENV.VOLC_ACCESS_TOKEN) ? '有' : '无',
    ENV.ARK_API_KEY ? '有' : '无');
  console.log('');
});
