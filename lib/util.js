'use strict';
// Shared paths, state store, backups and atomic writes.
const fs = require('fs');
const path = require('path');
const os = require('os');

// SKM_HOME lets tests run against a sandbox home instead of the real one.
const HOME = path.resolve(process.env.SKM_HOME || os.homedir());
const DATA = path.join(HOME, '.skill-manager');
const STATE_FILE = path.join(DATA, 'state.json');
const STORE = path.join(HOME, '.agents', 'skills');
const LOCK_FILE = path.join(HOME, '.agents', '.skill-lock.json');

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function rel(p) {
  const r = path.relative(HOME, p);
  return r.startsWith('..') ? p : '~/' + r.split(path.sep).join('/');
}

function isUnderHome(p) {
  const r = path.relative(HOME, path.resolve(p));
  return !!r && !r.startsWith('..') && !path.isAbsolute(r);
}

function safeName(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '_');
}

function emptyState() {
  return { version: 1, disabledSkills: [], disabledMcp: [], trash: [], log: [] };
}

function loadState() {
  try {
    return Object.assign(emptyState(), JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
  } catch {
    return emptyState();
  }
}

function saveState(state) {
  ensureDir(DATA);
  state.log = (state.log || []).slice(-500);
  atomicWrite(STATE_FILE, JSON.stringify(state, null, 2));
}

function logOp(state, op) {
  state.log.push(Object.assign({ at: new Date().toISOString() }, op));
}

// Copy a file into ~/.skill-manager/backups/<stamp>/ before it is modified.
let sessionStamp = null;
function backup(file) {
  if (!fs.existsSync(file)) return null;
  sessionStamp = sessionStamp || stamp();
  const dest = path.join(DATA, 'backups', sessionStamp, safeName(rel(file)));
  ensureDir(path.dirname(dest));
  if (!fs.existsSync(dest)) fs.copyFileSync(file, dest);
  return dest;
}

function atomicWrite(file, text) {
  const tmp = file + '.skm-tmp-' + process.pid;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function lstat(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}

function exists(p) {
  try { fs.statSync(p); return true; } catch { return false; }
}

module.exports = {
  HOME, DATA, STATE_FILE, STORE, LOCK_FILE,
  stamp, ensureDir, rel, isUnderHome, safeName,
  loadState, saveState, logOp, backup, atomicWrite, lstat, exists,
};
