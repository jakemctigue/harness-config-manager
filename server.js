'use strict';
// Local-only HTTP server for the Harness Config Manager UI. Binds 127.0.0.1 and requires a
// per-launch token on every API call so other web pages cannot drive it.
//   node server.js                 start and open the app window
//   node server.js bundle.mcpb     start and open the .mcpb installer for that file
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const U = require('./lib/util');
const P = require('./lib/platform');
const skills = require('./lib/skills');
const mcp = require('./lib/mcp');
const plugins = require('./lib/plugins');
const mcpb = require('./lib/mcpb');
const files = require('./lib/files');
const harness = require('./lib/harness');
const mcpproc = require('./lib/mcpproc');

const TOKEN = crypto.randomBytes(16).toString('hex');
const PORT = Number(process.env.SKM_PORT || 47777);
const INDEX = path.join(__dirname, 'public', 'index.html');
const OPEN_FILE = process.argv.slice(2).find((a) => /\.(mcpb|dxt)$/i.test(a));

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

function userPath(p) {
  const abs = path.resolve(String(p).replace(/^~[\\/]?/, U.HOME + path.sep));
  if (!U.isUnderHome(abs)) throw new Error('path outside home');
  return abs;
}

// A .mcpb arrives either as base64 from the browser or as a local path (CLI / file association).
function bundleBuf(b) {
  if (b.b64) return Buffer.from(b.b64, 'base64');
  if (b.localPath) {
    if (!/\.(mcpb|dxt)$/i.test(b.localPath)) throw new Error('not a .mcpb file');
    return fs.readFileSync(path.resolve(b.localPath));
  }
  throw new Error('no bundle given');
}

const routes = {
  'GET /api/scan': () => ({ home: U.HOME, data: U.rel(U.DATA), os: P.osName(), platform: P.OS,
    skills: skills.scan(), mcp: mcp.scan(), plugins: plugins.scan(), openFile: OPEN_FILE || null }),
  'GET /api/skill': (q) => ({ text: skills.readSkillMd(q.get('name')) }),
  'POST /api/skills/toggle': (q, b) => skills.setEnabled(b),
  'POST /api/skills/prune': (q, b) => skills.prune(b),
  'POST /api/skills/restore': (q, b) => skills.restore(b),
  'POST /api/mcp/toggle': (q, b) => mcp.setEnabled(b),
  'GET /api/mcp/processes': () => mcpproc.list(),
  'POST /api/mcp/restart': (q, b) => mcpproc.restart(b),
  'GET /api/mcp/targets': () => ({ targets: mcp.installTargets().map((t) => Object.assign({}, t, { file: undefined })) }),
  'POST /api/plugins/toggle': (q, b) => plugins.setEnabled(b),
  'POST /api/mcpb/inspect': (q, b) => { const i = mcpb.inspect(bundleBuf(b)); delete i.manifest.icon_data; return i; },
  'POST /api/mcpb/install': (q, b) => mcpb.install({ buf: bundleBuf(b), targets: b.targets, userValues: b.userValues, serverName: b.serverName }),
  'POST /api/mcpb/desktop': (q, b) => mcpb.openInClaudeDesktop({ buf: bundleBuf(b), fileName: b.fileName || b.localPath }),
  'GET /api/files': () => ({ files: files.discover().map((f) => Object.assign({}, f, { path: undefined })) }),
  'GET /api/files/skill': (q) => ({ files: files.skillFiles(q.get('name')).map((f) => Object.assign({}, f, { path: undefined })) }),
  'GET /api/file': (q) => files.read(q.get('path')),
  'POST /api/file': (q, b) => files.write(b),
  'POST /api/file/toggle': (q, b) => files.setEnabled(b),
  'POST /api/file/check': (q, b) => files.checkFile(b),
  'POST /api/file/diagnose': (q, b) => files.diagnose(b),
  'POST /api/file/restore-secrets': (q, b) => files.restoreRedacted(b),
  'GET /api/health': () => files.checkAll(),
  'GET /api/env': () => files.envScan(),
  'POST /api/env/set': (q, b) => files.envSet(b),
  'GET /api/harnesses': () => harness.status(),
  'POST /api/harnesses/restart': (q, b) => harness.restart(b),
  'POST /api/harnesses/prefs': (q, b) => harness.setPrefs(b),
  'GET /api/harness-id': (q) => ({ id: harness.idForLabel(q.get('label')) }),
  'POST /api/reveal': (q, b) => { P.reveal(userPath(b.path)); return { ok: true }; },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const host = (req.headers.host || '').split(':')[0];
  if (host !== '127.0.0.1' && host !== 'localhost') return send(res, 403, { error: 'bad host' });
  if (req.method === 'GET' && url.pathname === '/') {
    const html = fs.readFileSync(INDEX, 'utf8').replace('__SKM_TOKEN__', TOKEN);
    return send(res, 200, html, 'text/html; charset=utf-8');
  }
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return send(res, 404, { error: 'not found' });
  if (req.headers['x-skm-token'] !== TOKEN) return send(res, 403, { error: 'bad token' });
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    send(res, 200, await handler(url.searchParams, body));
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
