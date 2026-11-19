'use strict';
// Local-only HTTP server for the Harness Config Manager UI (browser mode). Binds 127.0.0.1 and
// requires a per-launch token on every API call so other web pages cannot drive it. The desktop
// app (desktop/main.js) serves the same routes over Electron IPC instead.
//   node server.js                 start and open the app window
//   node server.js bundle.mcpb     start and open the .mcpb installer for that file
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('./lib/platform');
const R = require('./lib/routes');

const TOKEN = crypto.randomBytes(16).toString('hex');
const PORT = Number(process.env.SKM_PORT || 47777);
const INDEX = path.join(__dirname, 'public', 'index.html');
R.setOpenFile(process.argv.slice(2).find((a) => /\.(mcpb|dxt)$/i.test(a)));

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 80e6) req.destroy(); else chunks.push(c); });
    req.on('end', () => { try { const t = Buffer.concat(chunks).toString('utf8'); resolve(t ? JSON.parse(t) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const host = (req.headers.host || '').split(':')[0];
  if (host !== '127.0.0.1' && host !== 'localhost') return send(res, 403, { error: 'bad host' });
  if (req.method === 'GET' && url.pathname === '/') {
    const html = fs.readFileSync(INDEX, 'utf8').replace('__SKM_TOKEN__', TOKEN);
    return send(res, 200, html, 'text/html; charset=utf-8');
  }
  if (!R.has(req.method, url.pathname)) return send(res, 404, { error: 'not found' });
  if (req.headers['x-skm-token'] !== TOKEN) return send(res, 403, { error: 'bad token' });
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    send(res, 200, await R.dispatch(req.method, req.url, body));
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

function listen(port, tries = 10) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries > 0) return listen(port + 1, tries - 1);
    console.error(e.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`Harness Config Manager running at ${url}  (${P.osName()}; close this window or press Ctrl+C to stop)`);
    if (!process.env.SKM_NO_OPEN) P.openAppWindow(url);
  });
}

listen(PORT);
