/* ============================================================================
 * Vercel Functions 入口 —— 部署后就是  wss://<你的域名>/api/asr
 *
 * Vercel 现在原生支持 WebSocket(需要 Fluid compute,2025-04-23 之后建的项目默认开)。
 * 写法就是导出一个 http.Server,ws 库原样能用,不需要额外配置。
 *
 * ⚠ 一个必须知道的限制:连接寿命 = 函数最长执行时长。
 *   Hobby 300 秒封顶,Pro 800 秒,扩展版 1800 秒。
 *   也就是说免费版每 5 分钟会断一次 —— 前端做了自动重连,
 *   断的时候只丢不到一秒的音频,已有字幕不会丢,用户基本无感。
 * ==========================================================================*/
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { attachRelay } from '../lib/relay.js';

const server = http.createServer((req, res) => {
  // 用浏览器直接访问 /api/asr 时给个说明,免得看到一片空白以为挂了
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    ok: true,
    service: '同声传译中转',
    hint: '这个地址是 WebSocket 端点,不是给浏览器直接打开的。请访问站点首页 /。',
    ws: 'wss://<本站域名>/api/asr'
  }, null, 2));
});

attachRelay(new WebSocketServer({ server }));

export default server;
