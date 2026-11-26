'use strict';
// Harness plugins and extensions that have an on/off switch of their own:
//   Claude Code plugins     ~/.claude/settings.json  enabledPlugins { "name@marketplace": bool }
//   Codex plugins           ~/.codex/config.toml     [plugins."name@marketplace"] enabled = bool
//                           (also [plugins.'name@marketplace'], which the ChatGPT / Codex app writes;
//                           files in ~/.codex/plugins/cache/<marketplace>/<name>/<version>/)
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
const codexCache = () => path.join(U.HOME, '.codex', 'plugins', 'cache');
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
    // keys: bare, "basic" or 'literal' (TOML); the ChatGPT / Codex app writes literal ones
    const m = lines[i].match(/^\s*\[\s*plugins\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_@.-]+)\s*\]\s*$/);
    cur = m ? { key: m[1].replace(/^(["'])([\s\S]*)\1$/, '$2'), header: i, enabledLine: -1 } : null;
    if (cur) blocks.push(cur);
  }
  for (const b of blocks) b.enabled = b.enabledLine >= 0 ? /=\s*true/.test(lines[b.enabledLine]) : true;
  return { lines, blocks };
}

const splitKey = (key) => { const at = key.lastIndexOf('@'); return at > 0 ? [key.slice(0, at), key.slice(at + 1)] : [key, '']; };

// A Codex plugin's local copy (newest version folder in the cache) and what it brings:
// { dir, version, description, skills, mcpFile } or null when it has no local files (remote apps).
function codexPluginInfo(name, market) {
  const base = path.join(codexCache(), market, name);
  const hasManifest = (d) => fs.existsSync(path.join(d, '.codex-plugin', 'plugin.json'));
  const vers = listDir(base).filter((e) => e.isDirectory() && /^\d/.test(e.name)).map((e) => e.name).sort((a, b) => P.compareVersions(b, a));
  const dir = vers.map((v) => path.join(base, v)).find(hasManifest) || (hasManifest(path.join(base, 'latest')) ? path.join(base, 'latest') : null);
  if (!dir) return null;
  const m = readJson(path.join(dir, '.codex-plugin', 'plugin.json')) || {};
  const mcpFile = [typeof m.mcpServers === 'string' ? path.resolve(dir, m.mcpServers) : null, path.join(dir, '.mcp.json')].find((f) => f && fs.existsSync(f)) || null;
  return { dir, version: String(m.version || path.basename(dir)), description: String(m.description || '').split(/\r?\n/)[0].trim(),
    skills: listDir(path.join(dir, 'skills')).filter((e) => e.isDirectory()).length, mcpFile };
}

function codexPlugins() {
  let text;
  try { text = fs.readFileSync(codexConfig(), 'utf8'); } catch { return []; }
  return codexBlocks(text).blocks.map((b) => {
    const [name, market] = splitKey(b.key);
    const info = codexPluginInfo(name, market);
    const brings = info ? [info.skills ? `${info.skills} skill${info.skills === 1 ? '' : 's'}` : '', info.mcpFile ? 'MCP server' : ''].filter(Boolean).join(', ') : '';
    return { id: 'codex:' + b.key, harness: U.CODEX_LABEL, kind: 'plugin', name, market, key: b.key, version: info ? info.version : '',
      installed: true, enabled: b.enabled, description: [info && info.description, brings && `Brings ${brings}.`].filter(Boolean).join(' '),
      path: info ? U.rel(info.dir) : '', file: U.rel(codexConfig()) };
  });
}

// MCP configs that enabled Codex plugins bring: [{ label, file }]. The plugin system owns these
// files, so they are listed read-only (switch the plugin off in the Plugins tab instead).
function codexPluginMcp() {
  return codexPlugins().filter((p) => p.enabled).map((p) => ({ p, info: codexPluginInfo(p.name, p.market) }))
    .filter((x) => x.info && x.info.mcpFile).map((x) => ({ label: `${U.CODEX_LABEL} (plugin ${x.p.name})`, file: x.info.mcpFile }));
}

// Folders of skills that harnesses load without them being in a skills folder of their own:
// skills inside enabled Codex / ChatGPT app plugins and Claude Code plugins, and Codex's built-in
// system skills. [{ harness, plugin, pluginId, dir }]. Shown read-only in the Skills tab; they are
// switched with their plugin.
function bundledSkillDirs() {
  const out = [];
  const sys = path.join(U.HOME, '.codex', 'skills', '.system');
  if (fs.existsSync(sys)) out.push({ harness: 'codex', plugin: 'built-in', pluginId: null, dir: sys });
  for (const p of codexPlugins()) {
    if (!p.enabled) continue;
    const info = codexPluginInfo(p.name, p.market);
    if (info && info.skills) out.push({ harness: 'codex', plugin: p.name, pluginId: p.id, dir: path.join(info.dir, 'skills') });
  }
  // Claude Desktop: account skills synced from claude.ai, its plugins (rpm/<org>/<account>/plugin_*)
  // and desktop extensions that ship skills. Store installs may keep a private copy of the folder.
  const cdRoots = [cdRoot()];
  if (P.IS_WIN) {
    const pk = path.join(P.localAppData(), 'Packages');
    for (const e of listDir(pk)) if (e.isDirectory() && /^Claude_/i.test(e.name)) cdRoots.push(path.join(pk, e.name, 'LocalCache', 'Roaming', 'Claude'));
  }
  const seenDirs = new Set();
  const addCd = (plugin, pluginId, dir, home) => {
    const k = path.resolve(dir).toLowerCase();
    if (seenDirs.has(k) || !fs.existsSync(dir)) return;
    seenDirs.add(k);
    out.push({ harness: 'claude-desktop', plugin, pluginId, dir, home });
  };
  for (const root of cdRoots) {
    const acct = path.join(root, 'local-agent-mode-sessions', 'skills-plugin');
    for (const a of listDir(acct)) for (const o of listDir(path.join(acct, a.name))) addCd('your Claude account', null, path.join(acct, a.name, o.name, 'skills'), root);
    const rpm = path.join(root, 'rpm');
    for (const a of listDir(rpm)) for (const o of listDir(path.join(rpm, a.name))) {
      const base = path.join(rpm, a.name, o.name);
      const man = readJson(path.join(base, 'manifest.json')) || {};
      for (const pdir of listDir(base)) {
        if (!pdir.isDirectory() || !/^plugin_/.test(pdir.name)) continue;
        const pm = readJson(path.join(base, pdir.name, '.claude-plugin', 'plugin.json')) || {};
        const entry = (man.plugins || []).find((x) => x.id === pdir.name) || {};
        addCd(pm.name || entry.displayName || entry.name || pdir.name, 'cd:' + pdir.name, path.join(base, pdir.name, 'skills'), root);
      }
    }
    for (const ext of listDir(path.join(root, 'Claude Extensions'))) {
      if (!ext.isDirectory()) continue;
      const m = readJson(path.join(root, 'Claude Extensions', ext.name, 'manifest.json')) || {};
      addCd(m.display_name || m.name || ext.name, 'desktop:' + ext.name, path.join(root, 'Claude Extensions', ext.name, 'skills'), root);
    }
  }
  for (const p of claudePlugins()) {
    if (!p.enabled || !p.path) continue;
    const dir = path.join(p.path.startsWith('~/') ? path.join(U.HOME, p.path.slice(2)) : p.path, 'skills');
    if (fs.existsSync(dir)) out.push({ harness: 'claude', plugin: p.name, pluginId: p.id, dir });
  }
  return out;
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
// Plugins Claude Desktop installed for your account (rpm/<org>/<account>/plugin_*). Read-only:
// they are managed in Claude Desktop (Customize > Plugins).
function desktopPlugins() {
  const out = [];
  const seen = new Set();
  for (const b of bundledSkillDirs()) {
    if (b.harness !== 'claude-desktop' || !b.pluginId || !b.pluginId.startsWith('cd:') || seen.has(b.pluginId)) continue;
    seen.add(b.pluginId);
    const dir = path.dirname(b.dir);
    const m = readJson(path.join(dir, '.claude-plugin', 'plugin.json')) || {};
    const n = listDir(b.dir).filter((e) => e.isDirectory()).length;
    out.push({ id: b.pluginId, harness: 'Claude Desktop', kind: 'plugin', name: b.plugin, market: '', key: b.pluginId.slice(3),
      version: String(m.version || ''), installed: true, enabled: true, readOnly: true,
      description: [String(m.description || '').split(/\r?\n/)[0], `Brings ${n} skill${n === 1 ? '' : 's'}. Managed in Claude Desktop.`].filter(Boolean).join(' '),
      path: U.rel(dir), file: U.rel(dir) });
  }
  return out;
}

function scan() {
  const items = [...claudePlugins(), ...codexPlugins(), ...geminiExtensions(), ...desktopExtensions(), ...desktopPlugins()];
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
      else if (kind === 'cd') throw new Error('this Claude Desktop plugin is managed in Claude Desktop (Customize > Plugins)');
      else throw new Error('unknown kind');
      res.changed++;
    } catch (e) { res.errors.push(`${key}: ${e.message}`); }
  }
  U.logOp(state, { op: enabled ? 'plugin-enable' : 'plugin-disable', ids, changed: res.changed });
  U.saveState(state);
  return res;
}

module.exports = { scan, setEnabled, bundledSkillDirs, codexBlocks, codexPluginInfo, codexPluginMcp, cdRoot, cdExtDir };
