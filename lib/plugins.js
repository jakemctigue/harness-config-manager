'use strict';
// Harness plugins and extensions that have an on/off switch of their own:
//   Claude Code plugins     ~/.claude/settings.json  enabledPlugins { "name@marketplace": bool }
//   Codex plugins           ~/.codex/config.toml     [plugins."name@marketplace"] enabled = bool
//   Gemini CLI extensions   ~/.gemini/extensions/<name>/  (disabled = folder moved to ~/.skill-manager/disabled)
//   Claude Desktop extensions (.mcpb / .dxt)  <appData>/Claude/Claude Extensions Settings/<id>.json { isEnabled }
// Every write is backed up first and every toggle is reversible.
const fs = require('fs');
const path = require('path');
const U = require('./util');
const P = require('./platform');
const mcp = require('./mcp');

const claudeSettings = () => path.join(U.HOME, '.claude', 'settings.json');
const claudeInstalled = () => path.join(U.HOME, '.claude', 'plugins', 'installed_plugins.json');
const codexConfig = () => path.join(U.HOME, '.codex', 'config.toml');
const geminiExtDir = () => path.join(U.HOME, '.gemini', 'extensions');
const cdRoot = () => path.join(P.appData(), 'Claude');
const cdExtDir = () => path.join(cdRoot(), 'Claude Extensions');
const cdSettingsDir = () => path.join(cdRoot(), 'Claude Extensions Settings');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}
function listDir(p) { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } }

function writeJsonPreserving(file, data) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  U.backup(file);
  U.ensureDir(path.dirname(file));
  U.atomicWrite(file, JSON.stringify(data, null, text ? mcp.indentOf(text) : 2) + (text && !text.endsWith('\n') ? '' : '\n'));
}

// ---------- Claude Code ----------
function claudePlugins() {
  const settings = readJson(claudeSettings()) || {};
  const enabled = settings.enabledPlugins || {};
  const inst = (readJson(claudeInstalled()) || {}).plugins || {};
  const keys = new Set([...Object.keys(enabled), ...Object.keys(inst)]);
  const out = [];
  for (const key of keys) {
    const [name, market] = key.split('@');
    const i = Array.isArray(inst[key]) ? inst[key][0] : inst[key];
    let description = '';
    if (i && i.installPath) {
      const man = readJson(path.join(i.installPath, '.claude-plugin', 'plugin.json')) || readJson(path.join(i.installPath, 'plugin.json'));
      if (man) description = man.description || '';
    }
    out.push({ id: 'claude:' + key, harness: 'Claude Code', kind: 'plugin', name, market: market || '', key,
      version: i ? i.version : '', installed: !!i, enabled: enabled[key] === true, description,
      path: i && i.installPath ? U.rel(i.installPath) : '', file: U.rel(claudeSettings()) });
  }
  return out;
}

function setClaudePlugin(key, on) {
  const file = claudeSettings();
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{}';
  const parsed = mcp.parseJson(text);
  if (!parsed || !parsed.editable) throw new Error(U.rel(file) + ' has comments or is invalid JSON; fix it first');
  parsed.data.enabledPlugins = parsed.data.enabledPlugins || {};
  parsed.data.enabledPlugins[key] = !!on;
  writeJsonPreserving(file, parsed.data);
}

// ---------- Codex ----------
function codexBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\[/.test(lines[i])) { if (cur && /^\s*enabled\s*=/.test(lines[i])) cur.enabledLine = i; continue; }
    const m = lines[i].match(/^\s*\[\s*plugins\s*\.\s*("(?:[^"\\]|\\.)*"|[A-Za-z0-9_@.-]+)\s*\]\s*$/);
    cur = m ? { key: m[1].replace(/^"|"$/g, ''), header: i, enabledLine: -1 } : null;
    if (cur) blocks.push(cur);
  }
  for (const b of blocks) b.enabled = b.enabledLine >= 0 ? /=\s*true/.test(lines[b.enabledLine]) : true;
  return { lines, blocks };
}

function codexPlugins() {
  let text;
  try { text = fs.readFileSync(codexConfig(), 'utf8'); } catch { return []; }
  return codexBlocks(text).blocks.map((b) => {
    const [name, market] = b.key.split('@');
    return { id: 'codex:' + b.key, harness: 'Codex', kind: 'plugin', name, market: market || '', key: b.key, version: '',
      installed: true, enabled: b.enabled, description: '', path: '', file: U.rel(codexConfig()) };
  });
}

function setCodexPlugin(key, on) {
  const file = codexConfig();
  const text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const { lines, blocks } = codexBlocks(text);
  const b = blocks.find((x) => x.key === key);
  if (!b) throw new Error('plugin not found in ' + U.rel(file));
  if (b.enabledLine >= 0) lines[b.enabledLine] = lines[b.enabledLine].replace(/=\s*(true|false)/, '= ' + (on ? 'true' : 'false'));
  else lines.splice(b.header + 1, 0, 'enabled = ' + (on ? 'true' : 'false'));
  U.backup(file);
  U.atomicWrite(file, lines.join(eol));
}

// ---------- Gemini CLI extensions ----------
function geminiDisabledDir() { return path.join(U.DATA, 'disabled', 'gemini-extensions'); }

function geminiExtensions() {
  const out = [];
  const add = (dir, enabled) => {
    for (const e of listDir(dir)) {
      if (!e.isDirectory()) continue;
      const man = readJson(path.join(dir, e.name, 'gemini-extension.json'));
      if (!man) continue;
      out.push({ id: 'gemini:' + e.name, harness: 'Gemini CLI', kind: 'extension', name: man.name || e.name, key: e.name,
        market: '', version: man.version || '', installed: true, enabled, description: man.description || '',
        path: U.rel(path.join(dir, e.name)), file: U.rel(path.join(dir, e.name, 'gemini-extension.json')),
        mcp: man.mcpServers ? Object.keys(man.mcpServers) : [] });
    }
  };
  add(geminiExtDir(), true);
  add(geminiDisabledDir(), false);
  return out;
}

function setGeminiExtension(key, on) {
  const from = path.join(on ? geminiDisabledDir() : geminiExtDir(), key);
  const to = path.join(on ? geminiExtDir() : geminiDisabledDir(), key);
  if (!U.exists(from)) throw new Error('extension folder not found');
  if (U.lstat(to)) throw new Error(U.rel(to) + ' already exists');
  U.ensureDir(path.dirname(to));
  fs.renameSync(from, to);
}

// ---------- Claude Desktop extensions ----------
function desktopExtensions() {
  const out = [];
  for (const e of listDir(cdExtDir())) {
    if (!e.isDirectory()) continue;
    const dir = path.join(cdExtDir(), e.name);
    const man = readJson(path.join(dir, 'manifest.json')) || {};
    const st = readJson(path.join(cdSettingsDir(), e.name + '.json')) || {};
    out.push({ id: 'desktop:' + e.name, harness: 'Claude Desktop', kind: 'extension', name: man.display_name || man.name || e.name, key: e.name,
      market: man.author && man.author.name ? man.author.name : '', version: man.version || '', installed: true,
      enabled: st.isEnabled !== false, description: man.description || '', path: U.rel(dir),
      file: U.rel(path.join(cdSettingsDir(), e.name + '.json')), userConfig: Object.keys(man.user_config || {}),
      server: man.server ? man.server.type : '' });
  }
  return out;
}

function setDesktopExtension(key, on) {
  if (!U.exists(path.join(cdExtDir(), key))) throw new Error('extension not installed');
  const file = path.join(cdSettingsDir(), key + '.json');
  const cur = readJson(file) || {};
  cur.isEnabled = !!on;
  writeJsonPreserving(file, cur);
}

// ---------- public ----------
function scan() {
  const items = [...claudePlugins(), ...codexPlugins(), ...geminiExtensions(), ...desktopExtensions()];
  items.sort((a, b) => a.harness.localeCompare(b.harness) || a.name.localeCompare(b.name));
  const harnesses = {};
  for (const i of items) {
    const h = harnesses[i.harness] = harnesses[i.harness] || { id: i.harness, label: i.harness, enabled: 0, disabled: 0 };
    h[i.enabled ? 'enabled' : 'disabled']++;
  }
  return { items, harnesses: Object.values(harnesses) };
}

// ids: ["claude:name@market", "codex:...", "gemini:folder", "desktop:id"]
function setEnabled({ ids, enabled }) {
  const res = { changed: 0, errors: [] };
  const state = U.loadState();
  for (const id of ids || []) {
    const i = id.indexOf(':');
    const kind = id.slice(0, i), key = id.slice(i + 1);
    try {
      if (kind === 'claude') setClaudePlugin(key, enabled);
      else if (kind === 'codex') setCodexPlugin(key, enabled);
      else if (kind === 'gemini') setGeminiExtension(key, enabled);
      else if (kind === 'desktop') setDesktopExtension(key, enabled);
      else throw new Error('unknown kind');
      res.changed++;
    } catch (e) { res.errors.push(`${key}: ${e.message}`); }
  }
  U.logOp(state, { op: enabled ? 'plugin-enable' : 'plugin-disable', ids, changed: res.changed });
  U.saveState(state);
  return res;
}

module.exports = { scan, setEnabled, codexBlocks, cdRoot, cdExtDir };
