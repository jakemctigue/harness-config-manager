'use strict';
// Every action the UI can ask for, keyed by "METHOD /path". server.js serves these over local HTTP
// (browser mode) and desktop/main.js serves them over Electron IPC (desktop mode).
const fs = require('fs');
const path = require('path');
const U = require('./util');
const P = require('./platform');
const skills = require('./skills');
const mcp = require('./mcp');
const plugins = require('./plugins');
const mcpb = require('./mcpb');
const files = require('./files');
const harness = require('./harness');
const mcpproc = require('./mcpproc');
const backup = require('./backup');

const BUNDLE_RE = /\.(mcpb|dxt)$/i;

// A .mcpb / .dxt the app was launched with; the UI opens its installer after the first scan.
let openFile = null;
function setOpenFile(p) { openFile = p && BUNDLE_RE.test(p) ? path.resolve(p) : null; }

function userPath(p) {
  const abs = path.resolve(String(p).replace(/^~[\\/]?/, U.HOME + path.sep));
  if (!U.isUnderHome(abs)) throw new Error('path outside home');
  return abs;
}

// A .mcpb arrives either as base64 from the browser or as a local path (CLI, file association,
// or a file dropped on the desktop window).
function bundleBuf(b) {
  if (b.b64) return Buffer.from(b.b64, 'base64');
  if (b.localPath) {
    if (!BUNDLE_RE.test(b.localPath)) throw new Error('not a .mcpb file');
    return fs.readFileSync(path.resolve(b.localPath));
  }
  throw new Error('no bundle given');
}

const routes = {
  'GET /api/scan': () => ({ home: U.HOME, data: U.rel(U.DATA), os: P.osName(), platform: P.OS,
    skills: skills.scan(), mcp: mcp.scan(), plugins: plugins.scan(), openFile }),
  'GET /api/skill': (q) => ({ text: skills.readSkillMd(q.get('name')) }),
  'POST /api/skills/toggle': (q, b) => skills.setEnabled(b),
  'POST /api/skills/prune': (q, b) => skills.prune(b),
  'POST /api/skills/restore': (q, b) => skills.restore(b),
  'POST /api/skills/export': (q, b) => { const r = skills.exportZip(b); P.reveal(r.abs); delete r.abs; return r; },
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
  'POST /api/harnesses/stop': (q, b) => harness.stop(b),
  'POST /api/harnesses/start': (q, b) => harness.start(b),
  'POST /api/harnesses/start-one': (q, b) => harness.startInstance(b),
  'POST /api/harnesses/prefs': (q, b) => harness.setPrefs(b),
  'GET /api/harness-id': (q) => ({ id: harness.idForLabel(q.get('label')), ids: harness.idsForLabel(q.get('label')) }),
  'GET /api/backups': () => backup.list(),
  'POST /api/backup/estimate': (q, b) => backup.estimate(b),
  'POST /api/backup/create': (q, b) => backup.create(b),
  'POST /api/backup/inspect': (q, b) => backup.inspect(b),
  'POST /api/backup/restore': (q, b) => backup.restore(b),
  'POST /api/backup/copy': (q, b) => backup.copyTo(b),
  'POST /api/reveal': (q, b) => { P.reveal(userPath(b.path)); return { ok: true }; },
};

function has(method, pathname) {
  return Object.prototype.hasOwnProperty.call(routes, `${method} ${pathname}`);
}

// Run one action. `url` is the same "/api/...?query" string the UI fetches in browser mode.
async function dispatch(method, url, body) {
  const u = new URL(String(url), 'http://127.0.0.1');
  if (!has(method, u.pathname)) throw Object.assign(new Error('not found'), { status: 404 });
  return routes[`${method} ${u.pathname}`](u.searchParams, body && typeof body === 'object' ? body : {});
}

module.exports = { routes, has, dispatch, setOpenFile, userPath, bundleBuf };
