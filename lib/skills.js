'use strict';
// Skill discovery and reversible enable/disable across every harness skill folder.
//
// Disable a linked skill  -> remove the junction, remember its target, recreate on enable.
// Disable a real folder   -> move it to ~/.skill-manager/disabled/<harness>/, move back on enable.
// Prune                   -> disable every install, move the store copy to ~/.skill-manager/trash/.
// Nothing is ever deleted outright.
const fs = require('fs');
const path = require('path');
const U = require('./util');

const SKIP = /[\\/](cache|vendor_imports|bundled|memories|marketplace[^\\/]*|node_modules|backups|plugins)[\\/]/i;
const IGNORE_TOP = new Set(['.skill-manager', '.agents', '.cache', '.npm', '.nuget', '.cargo', '.rustup', '.vscode', '.git']);

const LABELS = {
  claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', 'gemini/antigravity': 'Antigravity',
  'gemini/config': 'Gemini (config)', cursor: 'Cursor', 'codeium/windsurf': 'Windsurf', windsurf: 'Windsurf (~/.windsurf)',
  copilot: 'GitHub Copilot', kiro: 'Kiro', augment: 'Augment', continue: 'Continue', roo: 'Roo Code',
  kilocode: 'Kilo Code', opencode: 'opencode (~/.opencode)', 'config/opencode': 'opencode', 'config/goose': 'Goose',
  'config/crush': 'Crush', 'config/devin': 'Devin (config)', devin: 'Devin', 'pi/agent': 'Pi agent', pi: 'Pi',
  'snowflake/cortex': 'Snowflake Cortex', 'posit/assistant': 'Posit Assistant', 'tabnine/agent': 'Tabnine',
  'astrbot/data': 'AstrBot', openhands: 'OpenHands', grok: 'Grok', factory: 'Factory Droid', hermes: 'Hermes',
  qwen: 'Qwen Code', trae: 'Trae', 'trae-cn': 'Trae CN', qoder: 'Qoder', 'qoder-cn': 'Qoder CN', junie: 'Junie',
  'config/agents': 'Agents (config)', openclaw: 'OpenClaw', 'aider-desk': 'AiderDesk', iflow: 'iFlow', lingma: 'Lingma',
};

function harnessId(dir) {
  const r = path.relative(U.HOME, dir).split(path.sep);
  r.pop(); // trailing "skills"
  if (r[0]) r[0] = r[0].replace(/^\./, '');
  return r.join('/');
}

function harnessLabel(id) {
  if (LABELS[id]) return LABELS[id];
  const base = id.replace(/^config\//, '');
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function listDir(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; }
}

function isRealDir(p) {
  const st = U.lstat(p);
  return !!st && st.isDirectory() && !st.isSymbolicLink();
}

function findSkillDirs() {
  const out = new Set();
  const tryAdd = (p) => { if (!SKIP.test(p + path.sep) && isRealDir(p)) out.add(p); };
  for (const top of listDir(U.HOME)) {
    if (!top.name.startsWith('.') || IGNORE_TOP.has(top.name) || !top.isDirectory()) continue;
    const d = path.join(U.HOME, top.name);
    tryAdd(path.join(d, 'skills'));
    for (const c of listDir(d)) {
      if (c.isDirectory() && !c.isSymbolicLink()) tryAdd(path.join(d, c.name, 'skills'));
    }
  }
  return [...out];
}

function hasSkillMd(dir) {
  return U.exists(path.join(dir, 'SKILL.md')) || U.exists(path.join(dir, 'skill.md'));
}

function readFrontmatter(dir) {
  for (const f of ['SKILL.md', 'skill.md']) {
    let text;
    try {
      const fd = fs.openSync(path.join(dir, f), 'r');
      const buf = Buffer.alloc(6000);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      text = buf.slice(0, n).toString('utf8');
    } catch { continue; }
    const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return { description: text.replace(/^#.*$/m, '').trim().slice(0, 300) };
    const lines = m[1].split(/\r?\n/);
    const fm = {};
    for (let i = 0; i < lines.length; i++) {
      const kv = lines[i].match(/^([A-Za-z_-]+):\s*(.*)$/);
      if (!kv) continue;
      let v = kv[2].trim();
      if (v === '>' || v === '|' || v === '>-' || v === '|-' || v === '') {
        const parts = [];
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
        v = parts.join(' ');
      }
      fm[kv[1]] = v.replace(/^["']|["']$/g, '');
    }
    return fm;
  }
  return {};
}

function readLock() {
  try { return JSON.parse(fs.readFileSync(U.LOCK_FILE, 'utf8')); } catch { return null; }
}

function resolveTarget(linkPath) {
  try { return path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath)); } catch { return null; }
}

// Build the full picture. Stale state records (path re-created outside the app) are dropped.
function scanInternal(state) {
  const lock = readLock();
  const skills = new Map();
  const harnesses = new Map();
  const get = (name) => {
    if (!skills.has(name)) skills.set(name, { name, description: '', inStore: false, source: null, installs: [], trashed: false });
    return skills.get(name);
  };

  for (const e of listDir(U.STORE)) {
    const p = path.join(U.STORE, e.name);
    const st = U.lstat(p);
    if (!st || !(st.isDirectory() || st.isSymbolicLink()) || !hasSkillMd(p)) continue;
    const s = get(e.name);
    s.inStore = true;
    const fm = readFrontmatter(p);
    s.description = fm.description || '';
    const le = lock && lock.skills && lock.skills[e.name];
    if (le) s.source = le.source || le.sourceUrl || null;
  }

  const storeResolved = path.resolve(U.STORE).toLowerCase();
  for (const dir of findSkillDirs()) {
    const id = harnessId(dir);
    const h = { id, label: harnessLabel(id), dir, path: U.rel(dir), enabled: 0, disabled: 0 };
    for (const e of listDir(dir)) {
      const p = path.join(dir, e.name);
      const st = U.lstat(p);
      if (!st) continue;
      let inst;
      if (st.isSymbolicLink()) {
        const target = resolveTarget(p);
        inst = { harness: id, name: e.name, path: p, kind: 'link', target, enabled: true,
          broken: !U.exists(p), local: !target || !target.toLowerCase().startsWith(storeResolved) };
      } else if (st.isDirectory() && hasSkillMd(p)) {
        inst = { harness: id, name: e.name, path: p, kind: 'dir', target: null, enabled: true, broken: false, local: true };
      } else continue;
      const s = get(e.name);
      if (!s.description && !inst.broken) s.description = readFrontmatter(p).description || '';
      s.installs.push(inst);
      h.enabled++;
    }
    harnesses.set(id, h);
  }

  const keep = [];
  for (const rec of state.disabledSkills) {
    if (U.lstat(rec.path)) continue; // re-created outside the app; it is enabled again
    keep.push(rec);
    const s = get(rec.name);
    s.installs.push({ harness: rec.harness, name: rec.name, path: rec.path, kind: rec.kind, target: rec.target,
      enabled: false, broken: false, local: rec.kind === 'dir', reason: rec.reason });
    if (!harnesses.has(rec.harness)) {
      const dir = path.dirname(rec.path);
      harnesses.set(rec.harness, { id: rec.harness, label: harnessLabel(rec.harness), dir, path: U.rel(dir), enabled: 0, disabled: 0 });
    }
    harnesses.get(rec.harness).disabled++;
  }
  const dropped = keep.length !== state.disabledSkills.length;
  state.disabledSkills = keep;

  for (const t of state.trash) {
    const s = get(t.name);
    s.trashed = true;
    if (!s.description && t.description) s.description = t.description;
  }
  return { skills, harnesses, dropped };
}

function scan() {
  const state = U.loadState();
  const { skills, harnesses, dropped } = scanInternal(state);
  if (dropped) U.saveState(state);
  const list = [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const s of list) {
    s.installs.sort((a, b) => a.harness.localeCompare(b.harness));
    for (const i of s.installs) i.path = U.rel(i.path), i.target = i.target && U.rel(i.target);
  }
  const hs = [...harnesses.values()].filter((h) => h.enabled + h.disabled > 0)
    .sort((a, b) => a.label.localeCompare(b.label));
  for (const h of hs) delete h.dir;
  return { harnesses: hs, skills: list, trash: state.trash };
}

function uniquePath(p) {
  let out = p, n = 1;
  while (U.lstat(out)) out = `${p}.${n++}`;
  return out;
}

function removeLink(p) {
  const st = U.lstat(p);
  if (!st || !st.isSymbolicLink()) throw new Error('refusing to remove: not a link');
  try { fs.unlinkSync(p); } catch (e) {
    if (e.code !== 'EPERM' && e.code !== 'EISDIR') throw e;
    fs.rmdirSync(p); // removes a directory junction without touching its target
  }
}

function disableInstall(state, inst, reason) {
  const st = U.lstat(inst.path);
  if (!st) throw new Error('not found on disk');
  const rec = { harness: inst.harness, name: inst.name, path: inst.path, kind: inst.kind, target: inst.target,
    stash: null, reason: reason || 'disable', at: new Date().toISOString() };
  if (inst.kind === 'link') {
    if (!inst.target) throw new Error('cannot read link target');
    removeLink(inst.path);
  } else {
    if (!isRealDir(inst.path)) throw new Error('expected a folder');
    rec.stash = uniquePath(path.join(U.DATA, 'disabled', U.safeName(inst.harness), inst.name));
    U.ensureDir(path.dirname(rec.stash));
    fs.renameSync(inst.path, rec.stash);
  }
  state.disabledSkills.push(rec);
}

function enableInstall(state, inst) {
  const idx = state.disabledSkills.findIndex((r) => r.path === inst.path && r.name === inst.name);
  if (idx < 0) throw new Error('no disable record');
  const rec = state.disabledSkills[idx];
  if (U.lstat(rec.path)) throw new Error('something already exists at ' + U.rel(rec.path));
  U.ensureDir(path.dirname(rec.path));
  if (rec.kind === 'link') {
    if (!U.exists(rec.target)) throw new Error('link target is gone (' + U.rel(rec.target) + ')');
    fs.symlinkSync(rec.target, rec.path, process.platform === 'win32' ? 'junction' : 'dir');
  } else {
    fs.renameSync(rec.stash, rec.path);
  }
  state.disabledSkills.splice(idx, 1);
}

// names: skill names; harnesses: array of harness ids or null for every harness.
function setEnabled({ names, harnesses, enabled }) {
  const state = U.loadState();
  const { skills } = scanInternal(state);
  const res = { changed: 0, errors: [] };
  for (const name of names || []) {
    const s = skills.get(name);
    if (!s) { res.errors.push(`${name}: not found`); continue; }
    for (const inst of s.installs) {
      if (harnesses && !harnesses.includes(inst.harness)) continue;
      if (inst.enabled === !!enabled) continue;
      if (enabled && inst.reason === 'prune' && s.trashed) continue; // restore from Trash instead
      try {
        enabled ? enableInstall(state, inst) : disableInstall(state, inst);
        res.changed++;
      } catch (e) { res.errors.push(`${name} @ ${inst.harness}: ${e.message}`); }
    }
  }
  U.logOp(state, { op: enabled ? 'skill-enable' : 'skill-disable', names, harnesses, changed: res.changed });
  U.saveState(state);
  return res;
}

function prune({ names }) {
  const state = U.loadState();
  const { skills } = scanInternal(state);
  const res = { changed: 0, errors: [] };
  let lock = readLock();
  const lockBefore = lock && JSON.stringify(lock);
  const trashDir = path.join(U.DATA, 'trash', U.stamp());
  for (const name of names || []) {
    const s = skills.get(name);
    if (!s || s.trashed) { res.errors.push(`${name}: not found or already in trash`); continue; }
    let failed = false;
    for (const inst of s.installs.filter((i) => i.enabled)) {
      try { disableInstall(state, inst, 'prune'); } catch (e) { failed = true; res.errors.push(`${name} @ ${inst.harness}: ${e.message}`); }
    }
    if (failed) continue;
    const rec = { name, from: null, to: null, lockEntry: null, description: s.description, at: new Date().toISOString() };
    if (s.inStore) {
      rec.from = path.join(U.STORE, name);
      rec.to = path.join(trashDir, name);
      U.ensureDir(trashDir);
      try { fs.renameSync(rec.from, rec.to); } catch (e) { res.errors.push(`${name}: move to trash failed: ${e.message}`); continue; }
      if (lock && lock.skills && lock.skills[name]) {
        rec.lockEntry = lock.skills[name];
        delete lock.skills[name];
      }
    }
    state.trash.push(rec);
    res.changed++;
  }
  if (lock && JSON.stringify(lock) !== lockBefore) {
    U.backup(U.LOCK_FILE);
    U.atomicWrite(U.LOCK_FILE, JSON.stringify(lock, null, 2));
  }
  U.logOp(state, { op: 'prune', names, changed: res.changed });
  U.saveState(state);
  return res;
}

function restore({ names }) {
  const state = U.loadState();
  const res = { changed: 0, errors: [] };
  const lock = readLock();
  let lockChanged = false;
  for (const name of names || []) {
    const idx = state.trash.findIndex((t) => t.name === name);
    if (idx < 0) { res.errors.push(`${name}: not in trash`); continue; }
    const rec = state.trash[idx];
    if (rec.from) {
      if (U.lstat(rec.from)) { res.errors.push(`${name}: ${U.rel(rec.from)} already exists`); continue; }
      try { fs.renameSync(rec.to, rec.from); } catch (e) { res.errors.push(`${name}: ${e.message}`); continue; }
      if (rec.lockEntry && lock && lock.skills) { lock.skills[name] = rec.lockEntry; lockChanged = true; }
    }
    state.trash.splice(idx, 1);
    for (const d of state.disabledSkills.filter((r) => r.name === name && r.reason === 'prune')) {
      try { enableInstall(state, { path: d.path, name }); } catch (e) { res.errors.push(`${name} @ ${d.harness}: ${e.message}`); }
    }
    res.changed++;
  }
  if (lockChanged) {
    U.backup(U.LOCK_FILE);
    U.atomicWrite(U.LOCK_FILE, JSON.stringify(lock, null, 2));
  }
  U.logOp(state, { op: 'restore', names, changed: res.changed });
  U.saveState(state);
  return res;
}

function readSkillMd(name) {
  const state = U.loadState();
  const { skills } = scanInternal(state);
  const s = skills.get(name);
  const dirs = [];
  if (s && s.inStore) dirs.push(path.join(U.STORE, name));
  if (s) for (const i of s.installs) if (i.enabled) dirs.push(i.path);
  const t = state.trash.find((x) => x.name === name);
  if (t && t.to) dirs.push(t.to);
  for (const d of dirs) {
    for (const f of ['SKILL.md', 'skill.md']) {
      try { return fs.readFileSync(path.join(d, f), 'utf8').slice(0, 60000); } catch {}
    }
  }
  return null;
}

module.exports = { scan, setEnabled, prune, restore, readSkillMd, findSkillDirs };
