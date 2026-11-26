'use strict';
// Backup and restore of harness configuration.
//
// A backup is one .hcmbackup file in ~/.skill-manager/snapshots/:
//   "HCMB" | version byte | flags byte (1 = encrypted) | uint32 header length | header JSON | payload
// The header is a public summary (date, counts, whether it holds env files) and never secrets.
// The payload is a zip holding manifest.json and the files; with a password it is encrypted with
// AES-256-GCM using a key derived by scrypt.
//
// Paths are stored relative to the home folder ("~/...") or the per-user app-data folder
// ("$APPDATA/..."), so a backup restores onto another machine or OS user.
// Restoring backs up every file it overwrites and moves replaced folders to the Trash, so a
// restore can itself be undone.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const U = require('./util');
const P = require('./platform');
const mcp = require('./mcp');
const files = require('./files');
const skills = require('./skills');
const { writeZip } = require('./zip');
const { readZip } = require('./mcpb');

const MAGIC = Buffer.from('HCMB');
const FORMAT_VERSION = 1;
const SNAP_DIR = () => path.join(U.DATA, 'snapshots');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache']);
const MAX_FILE = 50 * 1024 * 1024;

const CATEGORIES = {
  skills: 'Skills (the shared store, every harness skills folder and its links)',
  mcp: 'MCP server configs',
  plugins: 'Plugin and extension switches',
  config: 'Settings and instruction files (settings.json, CLAUDE.md, AGENTS.md...)',
  env: '.env files (secrets)',
  userenv: 'Windows user environment variables (secrets)',
  state: "This app's records (disabled items, Trash list, launch settings)",
};
const DEFAULT_CATS = ['skills', 'mcp', 'plugins', 'config', 'state'];

// ---------- Windows user environment variables (HKCU\Environment) ----------
// Kept in an object so tests can swap in a fake registry.
const USER_ENV_KEY = 'HKCU\\Environment';
const userEnv = {
  read() {
    if (!P.IS_WIN) return {};
    try { return P.parseRegQuery(require('child_process').execFileSync('reg.exe', ['query', USER_ENV_KEY], { encoding: 'utf8', windowsHide: true, timeout: 8000 })); }
    catch { return {}; }
  },
  write(name, { value, expand }) {
    require('child_process').execFileSync('reg.exe', ['add', USER_ENV_KEY, '/v', name, '/t', expand ? 'REG_EXPAND_SZ' : 'REG_SZ', '/d', value, '/f'],
      { windowsHide: true, timeout: 8000, stdio: 'ignore' });
  },
  // tell running programs (Explorer, new terminals) that the environment changed
  broadcast() {
    try {
      require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "[Environment]::SetEnvironmentVariable('SKM_ENV_REFRESH', $null, 'User')"], { windowsHide: true, timeout: 15000, stdio: 'ignore' });
    } catch {}
  },
};
const regVarOf = (rel) => (String(rel).startsWith('$USERENV/') ? rel.slice(9) : null);

// ---------- path mapping ----------
function toToken(abs) {
  const ad = path.resolve(P.appData());
  const ra = path.relative(ad, abs);
  if (ra && !ra.startsWith('..') && !path.isAbsolute(ra)) return '$APPDATA/' + ra.split(path.sep).join('/');
  const rh = path.relative(U.HOME, abs);
  if (rh && !rh.startsWith('..') && !path.isAbsolute(rh)) return '~/' + rh.split(path.sep).join('/');
  return null;
}
function fromToken(tok) {
  const t = String(tok);
  let abs;
  if (t.startsWith('$APPDATA/')) abs = path.join(P.appData(), ...t.slice(9).split('/'));
  else if (t.startsWith('~/')) abs = path.join(U.HOME, ...t.slice(2).split('/'));
  else throw new Error('bad path in backup: ' + t);
  if (!U.isUnderHome(abs) && !path.resolve(abs).startsWith(path.resolve(P.appData()))) throw new Error('path outside home in backup: ' + t);
  if (t.split('/').includes('..')) throw new Error('unsafe path in backup: ' + t);
  return abs;
}

// ---------- collecting ----------
function listDir(p) { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } }

function walkFiles(root) {
  const out = [];
  const walk = (dir, relParts) => {
    for (const e of listDir(dir)) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, relParts.concat(e.name)); continue; }
      if (!e.isFile()) continue;
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.size > MAX_FILE) continue;
      out.push({ abs: p, rel: relParts.concat(e.name).join('/'), size: st.size });
    }
  };
  walk(root, []);
  return out;
}

function collect(cats) {
  const want = new Set(cats);
  const items = new Map(); // key -> item
  const add = (cat, type, abs, extra = {}) => {
    const tok = toToken(abs);
    if (!tok) return;
    const key = P.IS_WIN || P.IS_MAC ? tok.toLowerCase() : tok;
    if (items.has(key)) { if (!items.get(key).cats.includes(cat)) items.get(key).cats.push(cat); return; }
    items.set(key, Object.assign({ cats: [cat], type, rel: tok, abs }, extra));
  };
  const addFile = (cat, abs) => {
    try { const st = fs.statSync(abs); if (st.isFile() && st.size <= MAX_FILE) add(cat, 'file', abs); } catch {}
  };
  const addEntry = (cat, abs) => {
    const st = U.lstat(abs);
    if (!st) return;
    if (st.isSymbolicLink()) {
      let target = null;
      try { target = path.resolve(path.dirname(abs), fs.readlinkSync(abs)); } catch {}
      const tt = target && toToken(target);
      if (tt) add(cat, 'link', abs, { target: tt, targetAbs: target });
    } else if (st.isDirectory()) add(cat, 'dir', abs);
    else if (st.isFile()) addFile(cat, abs);
  };

  if (want.has('skills')) {
    for (const e of listDir(U.STORE)) addEntry('skills', path.join(U.STORE, e.name));
    addFile('skills', U.LOCK_FILE);
    for (const dir of skills.findSkillDirs()) for (const e of listDir(dir)) addEntry('skills', path.join(dir, e.name));
  }
  if (want.has('mcp')) for (const [, f] of mcp.sourceFiles()) addFile('mcp', f);
  if (want.has('plugins')) {
    for (const f of [path.join(U.HOME, '.claude', 'settings.json'), path.join(U.HOME, '.claude', 'plugins', 'installed_plugins.json'),
      path.join(U.HOME, '.claude', 'plugins', 'known_marketplaces.json'), path.join(U.HOME, '.codex', 'config.toml'),
      path.join(U.HOME, '.gemini', 'extensions', 'extension-enablement.json')]) addFile('plugins', f);
    for (const e of listDir(path.join(P.appData(), 'Claude', 'Claude Extensions Settings'))) {
      if (e.isFile()) addFile('plugins', path.join(P.appData(), 'Claude', 'Claude Extensions Settings', e.name));
    }
  }
  if (want.has('config') || want.has('env')) {
    for (const f of files.discover()) {
      if (f.kind === 'env' ? want.has('env') : want.has('config')) addFile(f.kind === 'env' ? 'env' : 'config', f.path);
    }
  }
  if (want.has('env')) {
    for (const f of files.envScan().files) addFile('env', fromToken(f.rel));
  }
  if (want.has('userenv')) {
    for (const [name, v] of Object.entries(userEnv.read())) {
      items.set('$USERENV/' + name.toLowerCase(), { cats: ['userenv'], type: 'regvar', rel: '$USERENV/' + name, abs: null, value: { value: v.value, expand: !!v.expand } });
    }
  }
  if (want.has('state')) {
    addFile('state', U.STATE_FILE);
    if (fs.existsSync(path.join(U.DATA, 'disabled'))) add('state', 'dir', path.join(U.DATA, 'disabled'));
  }
  return [...items.values()];
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Size of what a backup with these categories would hold (for the create dialog).
function estimate({ cats } = {}) {
  const items = collect(cats && cats.length ? cats : DEFAULT_CATS);
  const byCat = {};
  for (const it of items) {
    const c = it.cats[0];
    const b = byCat[c] = byCat[c] || { items: 0, bytes: 0 };
    b.items++;
    if (it.type === 'file') { try { b.bytes += fs.statSync(it.abs).size; } catch {} }
    else if (it.type === 'dir') b.bytes += walkFiles(it.abs).reduce((n, f) => n + f.size, 0);
  }
  return { categories: CATEGORIES, defaults: DEFAULT_CATS, byCat };
}

// ---------- archive container ----------
function kdf(password, salt) {
  return crypto.scryptSync(String(password), salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function pack(header, zipBuf, password) {
  const flags = password ? 1 : 0;
  let payload = zipBuf;
  if (password) {
    const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', kdf(password, salt), iv);
    const enc = Buffer.concat([c.update(zipBuf), c.final()]);
    payload = Buffer.concat([salt, iv, c.getAuthTag(), enc]);
  }
  const h = Buffer.from(JSON.stringify(header), 'utf8');
  const pre = Buffer.alloc(10);
  MAGIC.copy(pre, 0); pre.writeUInt8(FORMAT_VERSION, 4); pre.writeUInt8(flags, 5); pre.writeUInt32LE(h.length, 6);
  return Buffer.concat([pre, h, payload]);
}

function readHeader(buf) {
  if (buf.length < 10 || !buf.slice(0, 4).equals(MAGIC)) throw new Error('not a Harness Config Manager backup');
  const version = buf.readUInt8(4);
  if (version > FORMAT_VERSION) throw new Error('this backup was made by a newer version of the app');
  const encrypted = !!(buf.readUInt8(5) & 1);
  const hl = buf.readUInt32LE(6);
  const header = JSON.parse(buf.slice(10, 10 + hl).toString('utf8'));
  return { header, encrypted, payload: buf.slice(10 + hl) };
}

function unpack(buf, password) {
  const { header, encrypted, payload } = readHeader(buf);
  let zipBuf = payload;
  if (encrypted) {
    if (!password) { const e = new Error('this backup is protected with a password'); e.code = 'NEEDS_PASSWORD'; throw e; }
    const salt = payload.slice(0, 16), iv = payload.slice(16, 28), tag = payload.slice(28, 44);
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', kdf(password, salt), iv);
      d.setAuthTag(tag);
      zipBuf = Buffer.concat([d.update(payload.slice(44)), d.final()]);
    } catch { const e = new Error('wrong password, or the backup is damaged'); e.code = 'BAD_PASSWORD'; throw e; }
  }
  const z = readZip(zipBuf);
  const byName = new Map(z.entries.map((e) => [e.name, e]));
  const me = byName.get('manifest.json');
  if (!me) throw new Error('backup has no manifest');
  const manifest = JSON.parse(z.read(me).toString('utf8'));
  return { header, encrypted, manifest, read: (name) => { const e = byName.get(name); if (!e) throw new Error('missing in backup: ' + name); return z.read(e); } };
}

// ---------- create ----------
function create({ cats, password, label } = {}) {
  const chosen = (cats && cats.length ? cats : DEFAULT_CATS).filter((c) => CATEGORIES[c]);
  if (password && String(password).length < 8) throw new Error('use a password of at least 8 characters');
  const name = U.stamp() + (label ? '-' + U.safeName(label).slice(0, 40) : '') + '.hcmbackup';
  // log first, so the app's own state in the backup already matches what is on disk
  const state = U.loadState();
  U.logOp(state, { op: 'backup-create', name, cats: chosen, encrypted: !!password });
  U.saveState(state);
  const items = collect(chosen);
  const entries = [];
  const manifestItems = [];
  let n = 0;
  for (const it of items) {
    const id = 'i' + (n++);
    const base = { id, cats: it.cats, type: it.type, rel: it.rel };
    if (it.type === 'file') {
      let data; try { data = fs.readFileSync(it.abs); } catch { continue; }
      entries.push({ name: `files/${id}`, data });
      manifestItems.push(Object.assign(base, { size: data.length, sha: sha(data) }));
    } else if (it.type === 'dir') {
      const list = [];
      for (const f of walkFiles(it.abs)) {
        let data; try { data = fs.readFileSync(f.abs); } catch { continue; }
        const zipName = `files/${id}/${f.rel}`;
        entries.push({ name: zipName, data });
        list.push({ p: f.rel, size: data.length, sha: sha(data) });
      }
      manifestItems.push(Object.assign(base, { files: list }));
    } else if (it.type === 'link') {
      manifestItems.push(Object.assign(base, { target: it.target }));
    } else if (it.type === 'regvar') {
      const data = Buffer.from(JSON.stringify(it.value));
      entries.push({ name: `files/${id}`, data });
      manifestItems.push(Object.assign(base, { size: data.length, sha: sha(data) }));
    }
  }
  const counts = {};
  for (const m of manifestItems) for (const c of m.cats) counts[c] = (counts[c] || 0) + 1;
  const createdAt = new Date().toISOString();
  const header = { format: 'harness-config-backup', createdAt, os: P.osName(), categories: chosen, counts,
    includesEnv: chosen.includes('env') || chosen.includes('userenv'), label: label ? String(label).slice(0, 80) : '' };
  const manifest = Object.assign({}, header, { version: FORMAT_VERSION, items: manifestItems });
  entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) });
  const buf = pack(header, writeZip(entries), password);
  U.ensureDir(SNAP_DIR());
  const file = path.join(SNAP_DIR(), name);
  fs.writeFileSync(file, buf);
  return { name, file: U.rel(file), size: buf.length, encrypted: !!password, counts, items: manifestItems.length };
}

// ---------- list / locate ----------
function list() {
  const out = [];
  for (const e of listDir(SNAP_DIR())) {
    if (!e.isFile() || !e.name.endsWith('.hcmbackup')) continue;
    const file = path.join(SNAP_DIR(), e.name);
    try {
      const fd = fs.openSync(file, 'r');
      const pre = Buffer.alloc(10); fs.readSync(fd, pre, 0, 10, 0);
      const hl = pre.slice(0, 4).equals(MAGIC) ? pre.readUInt32LE(6) : 0;
      const hb = Buffer.alloc(Math.min(hl, 1 << 20)); fs.readSync(fd, hb, 0, hb.length, 10);
      fs.closeSync(fd);
      const header = JSON.parse(hb.toString('utf8'));
      out.push(Object.assign({ name: e.name, file: U.rel(file), size: fs.statSync(file).size, encrypted: !!(pre.readUInt8(5) & 1) }, header));
    } catch { out.push({ name: e.name, file: U.rel(file), size: 0, damaged: true }); }
  }
  return { folder: U.rel(SNAP_DIR()), backups: out.sort((a, b) => b.name.localeCompare(a.name)) };
}

// A backup given by name (in the snapshots folder), a local path, or base64 bytes.
function source({ name, localPath, b64 }) {
  if (b64) return Buffer.from(b64, 'base64');
  if (name) {
    if (/[\\/]/.test(name) || !name.endsWith('.hcmbackup')) throw new Error('bad backup name');
    return fs.readFileSync(path.join(SNAP_DIR(), name));
  }
  if (localPath) return fs.readFileSync(path.resolve(String(localPath).replace(/^~(?=$|[\\/])/, U.HOME)));
  throw new Error('no backup given');
}

// ---------- inspect / restore ----------
function fileStatus(abs, wantSha) {
  try { return sha(fs.readFileSync(abs)) === wantSha ? 'same' : 'changed'; } catch { return 'new'; }
}

function itemStatus(m, current) {
  if (m.type === 'regvar') {
    if (!P.IS_WIN) return 'invalid';
    const name = regVarOf(m.rel);
    const cur = current || userEnv.read();
    const hit = Object.keys(cur).find((k) => k.toLowerCase() === name.toLowerCase());
    if (!hit) return 'new';
    return sha(Buffer.from(JSON.stringify({ value: cur[hit].value, expand: !!cur[hit].expand }))) === m.sha ? 'same' : 'changed';
  }
  let abs; try { abs = fromToken(m.rel); } catch { return 'invalid'; }
  if (m.type === 'file') return fileStatus(abs, m.sha);
  const st = U.lstat(abs);
  if (m.type === 'link') {
    if (!st) return 'new';
    if (!st.isSymbolicLink()) return 'changed';
    try { return path.resolve(path.dirname(abs), fs.readlinkSync(abs)) === path.resolve(fromToken(m.target)) ? 'same' : 'changed'; } catch { return 'changed'; }
  }
  if (!st) return 'new';
  if (!st.isDirectory() || st.isSymbolicLink()) return 'changed';
  const local = new Map(walkFiles(abs).map((f) => [f.rel, f]));
  if (local.size !== m.files.length) return 'changed';
  for (const f of m.files) { const l = local.get(f.p); if (!l || l.size !== f.size || fileStatus(l.abs, f.sha) !== 'same') return 'changed'; }
  return 'same';
}

function inspect(b) {
  const u = unpack(source(b), b.password);
  const curEnv = u.manifest.items.some((m) => m.type === 'regvar') ? userEnv.read() : null;
  const items = u.manifest.items.map((m) => ({ id: m.id, cats: m.cats, type: m.type, rel: m.rel, target: m.target,
    files: m.files ? m.files.length : undefined, size: m.size, status: itemStatus(m, curEnv || undefined) }));
  const summary = {};
  for (const it of items) {
    const c = it.cats[0];
    const s = summary[c] = summary[c] || { new: 0, changed: 0, same: 0, invalid: 0 };
    s[it.status]++;
  }
  return { header: u.header, encrypted: u.encrypted, categories: CATEGORIES, items, summary };
}

function moveAside(abs, trashRoot, tok) {
  const dest = path.join(trashRoot, U.safeName(tok));
  U.ensureDir(trashRoot);
  fs.renameSync(abs, dest);
  return dest;
}

function removeLink(abs) {
  try { fs.unlinkSync(abs); } catch (e) { if (e.code !== 'EPERM' && e.code !== 'EISDIR') throw e; fs.rmdirSync(abs); }
}

// ids: item ids to restore (default: everything that is new or changed in the chosen cats).
function restore(b) {
  const u = unpack(source(b), b.password);
  const cats = b.cats && b.cats.length ? new Set(b.cats) : null;
  const ids = b.ids ? new Set(b.ids) : null;
  const chosen = u.manifest.items.filter((m) => (ids ? ids.has(m.id) : true) && (!cats || m.cats.some((c) => cats.has(c))));
  const res = { changed: 0, skipped: 0, errors: [], replacedTo: null };
  const trashRoot = path.join(U.DATA, 'trash', U.stamp() + '-replaced-by-restore');
  // folders and files first, links last (their targets may be restored in this run), our own state at the end
  const order = (m) => (m.type === 'link' ? 2 : m.rel.endsWith('/.skill-manager/state.json') ? 3 : 1);
  chosen.sort((a, b2) => order(a) - order(b2));
  const state = U.loadState();
  U.logOp(state, { op: 'backup-restore', from: b.name || 'file', items: chosen.length });
  U.saveState(state);
  const before = {}; // user env values a restore replaces, kept so it can be undone
  let envChanged = false;
  for (const m of chosen) {
    try {
      const status = itemStatus(m);
      if (status === 'same') { res.skipped++; continue; }
      if (status === 'invalid') throw new Error(m.type === 'regvar' ? 'Windows user environment variables can only be restored on Windows' : 'path not valid on this machine');
      if (m.type === 'regvar') {
        const name = regVarOf(m.rel);
        if (!/^[A-Za-z_][A-Za-z0-9_.()-]*$/.test(name)) throw new Error('not a valid variable name');
        const cur = userEnv.read();
        const hit = Object.keys(cur).find((k) => k.toLowerCase() === name.toLowerCase());
        before[name] = hit ? cur[hit] : null;
        const v = JSON.parse(u.read(`files/${m.id}`).toString('utf8'));
        userEnv.write(name, { value: String(v.value), expand: !!v.expand });
        envChanged = true;
        res.changed++;
        continue;
      }
      const abs = fromToken(m.rel);
      const st = U.lstat(abs);
      if (m.type === 'file') {
        if (st && (st.isDirectory() || st.isFile())) { moveAside(abs, trashRoot, m.rel); res.replacedTo = U.rel(trashRoot); }
        else if (st && st.isSymbolicLink()) removeLink(abs);
        U.ensureDir(path.dirname(abs));
        U.atomicWrite(abs, u.read(`files/${m.id}`));
      } else if (m.type === 'dir') {
        if (st) {
          if (st.isSymbolicLink()) removeLink(abs);
          else { moveAside(abs, trashRoot, m.rel); res.replacedTo = U.rel(trashRoot); }
        }
        U.ensureDir(abs);
        for (const f of m.files) {
          if (f.p.split('/').includes('..')) throw new Error('unsafe path in backup');
          const dest = path.join(abs, ...f.p.split('/'));
          U.ensureDir(path.dirname(dest));
          fs.writeFileSync(dest, u.read(`files/${m.id}/${f.p}`));
        }
      } else if (m.type === 'link') {
        const target = fromToken(m.target);
        if (!fs.existsSync(target)) throw new Error('its target is missing: ' + m.target);
        if (st) {
          if (st.isSymbolicLink()) removeLink(abs);
          else { moveAside(abs, trashRoot, m.rel); res.replacedTo = U.rel(trashRoot); }
        }
        U.ensureDir(path.dirname(abs));
        fs.symlinkSync(target, abs, P.IS_WIN ? 'junction' : 'dir');
      }
      res.changed++;
    } catch (e) { res.errors.push(`${m.rel}: ${e.message}`); }
  }
  if (envChanged) {
    U.ensureDir(trashRoot);
    fs.writeFileSync(path.join(trashRoot, 'user-environment-before-restore.json'), JSON.stringify(before, null, 2), { mode: 0o600 });
    res.replacedTo = U.rel(trashRoot);
    res.envChanged = true;
    userEnv.broadcast();
  }
  return res;
}

// Copy a backup out of the snapshots folder, e.g. to another drive.
function copyTo({ name, folder }) {
  const src = path.join(SNAP_DIR(), path.basename(String(name)));
  if (!fs.existsSync(src) || !src.endsWith('.hcmbackup')) throw new Error('backup not found');
  const dir = path.resolve(String(folder).replace(/^~(?=$|[\\/])/, U.HOME));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('that folder does not exist');
  const dest = path.join(dir, path.basename(src));
  if (fs.existsSync(dest)) throw new Error(dest + ' already exists');
  fs.copyFileSync(src, dest);
  return { ok: true, file: dest };
}

module.exports = { userEnv, CATEGORIES, DEFAULT_CATS, collect, estimate, create, list, inspect, restore, copyTo, toToken, fromToken, pack, unpack, readHeader };
