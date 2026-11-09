'use strict';
// MCP server discovery and reversible enable/disable across harness config files.
//
// Disable -> the server's entry is cut out of the config (after a backup) and kept verbatim in
//            ~/.skill-manager/state.json; enable puts the same entry back.
// JSON configs that only parse after stripping comments, and YAML configs, are listed read-only.
const fs = require('fs');
const path = require('path');
const U = require('./util');

const P = require('./platform');

// '$APP' is the per-user app-data folder (AppData/Roaming, Library/Application Support or ~/.config).
const VSC = '$APP/Code/User';
const SOURCES = [
  ['Claude Code', '.claude.json'],
  ['Claude Code (settings)', '.claude/settings.json'],
  ['Claude Desktop', '$APP/Claude/claude_desktop_config.json'],
  ['Codex', '.codex/config.toml'],
  ['Cursor', '.cursor/mcp.json'],
  ['Windsurf', '.codeium/windsurf/mcp_config.json'],
  ['Codeium', '.codeium/mcp_config.json'],
  ['Gemini CLI', '.gemini/settings.json'],
  ['Antigravity', '.gemini/antigravity/mcp_config.json'],
  ['Gemini (config)', '.gemini/config/mcp_config.json'],
  ['VS Code', `${VSC}/mcp.json`],
  ['VS Code Insiders', '$APP/Code - Insiders/User/mcp.json'],
  ['VSCodium', '$APP/VSCodium/User/mcp.json'],
  ['Cline', `${VSC}/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`],
  ['Roo Code', `${VSC}/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json`],
  ['Kilo Code', `${VSC}/globalStorage/kilocode.kilo-code/settings/mcp_settings.json`],
  ['Cline (~/.cline)', '.cline/data/settings/cline_mcp_settings.json'],
  ['Roo Code (~/.roo)', '.roo/mcp.json'],
  ['Kilo Code (~/.kilocode)', '.kilocode/mcp.json'],
  ['GitHub Copilot CLI', '.copilot/mcp-config.json'],
  ['Kiro', '.kiro/settings/mcp.json'],
  ['Factory Droid', '.factory/mcp.json'],
  ['Devin', '.devin/mcp_config.json'],
  ['Devin (config)', '.config/devin/mcp_config.json'],
  ['Trae', '.trae/mcp.json'],
  ['Trae CN', '.trae-cn/mcp.json'],
  ['Qoder', '.qoder/mcp.json'],
  ['CodeBuddy', '.codebuddy/mcp.json'],
  ['Lingma', '.lingma/mcp.json'],
  ['Junie', '.junie/mcp/mcp.json'],
  ['opencode', '.config/opencode/opencode.json'],
  ['opencode (jsonc)', '.config/opencode/opencode.jsonc'],
  ['Crush', '.config/crush/crush.json'],
  ['Amp', '.config/amp/settings.json'],
  ['Zed', '$APP/Zed/settings.json'],
  ['Zed', '.config/zed/settings.json'],
  ['Pi agent', '.pi/agent/mcp.json'],
  ['LM Studio', '.lmstudio/mcp.json'],
  ['Bob', '.bob/mcp.json'],
  ['Bob (settings)', '.bob/settings/mcp_settings.json'],
  ['Bob (legacy)', '.bob/mcp_settings.json'],
  ['CodeGPT', '.codegpt/mcp_config.json'],
  ['Qwen Code', '.qwen/settings.json'],
  ['iFlow', '.iflow/settings.json'],
  ['Augment', '.augment/settings.json'],
  ['Grok', '.grok/settings.json'],
  ['Goose', '.config/goose/config.yaml'],
  ['Goose', '$APP/Block/goose/config/config.yaml'],
  ['Hermes', '.hermes/config.yaml'],
  ['Continue', '.continue/config.yaml'],
];

// Resolve SOURCES for this OS, dropping duplicates (on Linux $APP is ~/.config).
function sourceFiles() {
  const seen = new Set();
  const out = [];
  for (const [harness, rel] of SOURCES) {
    const file = rel.startsWith('$APP/') ? path.join(P.appData(), rel.slice(5)) : path.join(U.HOME, rel);
    const k = process.platform === 'win32' || process.platform === 'darwin' ? file.toLowerCase() : file;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([harness, file]);
  }
  return out;
}
const JSON_KEYS = ['mcpServers', 'servers', 'mcp', 'context_servers', 'amp.mcpServers', 'mcp_servers'];

function stripJsonc(text) {
  let out = '', i = 0, inStr = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += n; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
    } else if (c === '"') { inStr = true; out += c; i++; }
    else if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; }
    else if (c === '/' && n === '*') { i = text.indexOf('*/', i + 2); i = i < 0 ? text.length : i + 2; }
    else { out += c; i++; }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function parseJson(text) {
  const t = text.replace(/^﻿/, '');
  try { return { data: JSON.parse(t), editable: true }; } catch {}
  try { return { data: JSON.parse(stripJsonc(t)), editable: false }; } catch { return null; }
}

function getAt(obj, keyPath) {
  return keyPath.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

function summarize(v) {
  if (!v || typeof v !== 'object') return '';
  if (v.url || v.serverUrl || v.httpUrl) return v.url || v.serverUrl || v.httpUrl;
  const cmd = Array.isArray(v.command) ? v.command.join(' ') : v.command;
  const args = Array.isArray(v.args) ? v.args.join(' ') : '';
  return [cmd, args].filter(Boolean).join(' ').slice(0, 200);
}

function indentOf(text) {
  const m = text.match(/\n([ \t]+)"/);
  return m ? m[1] : 2;
}

// ---------- TOML (Codex) ----------
function tomlHeaderName(line) {
  const m = line.match(/^\s*\[\s*mcp_servers\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)/);
  if (!m || /^\s*\[\[/.test(line)) return null;
  return m[1].replace(/^["']|["']$/g, '');
}

function tomlBlocks(text) {
  // A server's block runs from its [mcp_servers.<name>...] header to the next header that
  // belongs to something else; sub-tables like [mcp_servers.<name>.env] stay in the block.
  const lines = text.split(/\r?\n/);
  const blocks = new Map();
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\[/.test(lines[i])) continue;
    const name = tomlHeaderName(lines[i]);
    if (cur && name === cur.name) continue;
    if (cur) { cur.ranges[cur.ranges.length - 1][1] = i; cur = null; }
    if (name) {
      if (!blocks.has(name)) blocks.set(name, { name, ranges: [] });
      cur = blocks.get(name);
      cur.ranges.push([i, lines.length]);
    }
  }
  for (const b of blocks.values()) {
    for (const r of b.ranges) while (r[1] > r[0] + 1 && /^\s*(#.*)?$/.test(lines[r[1] - 1])) r[1]--;
    const body = b.ranges.map(([s, e]) => lines.slice(s, e).join('\n')).join('\n');
    const cmd = body.match(/^\s*command\s*=\s*(.+)$/m);
    const url = body.match(/^\s*url\s*=\s*(.+)$/m);
    const en = body.match(/^\s*enabled\s*=\s*false/m);
    const argsLine = body.match(/^\s*args\s*=\s*\[(.*)\]\s*$/m);
    b.command = cmd ? cmd[1].trim().replace(/^["']|["']$/g, '') : '';
    b.args = argsLine ? [...argsLine[1].matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]) : [];
    b.summary = (url ? url[1].replace(/["']/g, '') : [b.command, ...b.args].filter(Boolean).join(' ')).slice(0, 200);
    b.nativeOff = !!en;
  }
  return { lines, blocks };
}

// ---------- YAML (read-only, shallow) ----------
function yamlServers(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^(mcp_servers|mcpServers|extensions):\s*$/.test(lines[i])) continue;
    let childIndent = null;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (/^\S/.test(l)) break;
      if (!l.trim() || l.trim().startsWith('#')) continue;
      const ind = l.match(/^\s*/)[0].length;
      if (childIndent === null) childIndent = ind;
      if (ind !== childIndent) continue;
      const m = l.match(/^\s*-\s*name:\s*(.+)$/) || l.match(/^\s*([^\s:#-][^:]*):\s*$/);
      if (m) out.push(m[1].trim().replace(/^["']|["']$/g, ''));
    }
  }
  return out;
}

// ---------- discovery ----------
function configs() {
  const found = [];
  for (const [harness, file] of sourceFiles()) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const ext = path.extname(file).toLowerCase();
    if (ext === '.toml') {
      const { blocks } = tomlBlocks(text);
      found.push({ harness, file, format: 'toml', editable: true, entries: [...blocks.values()].map((b) => ({
        name: b.name, keyPath: null, summary: b.summary, nativeOff: b.nativeOff })) });
    } else if (ext === '.yaml' || ext === '.yml') {
      const names = yamlServers(text);
      if (names.length) found.push({ harness, file, format: 'yaml', editable: false,
        entries: names.map((name) => ({ name, keyPath: null, summary: '' })) });
    } else {
      const parsed = parseJson(text);
      if (!parsed) continue;
      const groups = [];
      for (const k of JSON_KEYS) {
        const v = parsed.data[k];
        if (v && typeof v === 'object' && !Array.isArray(v)) { groups.push({ harness, keyPath: [k] }); break; }
      }
      if (path.basename(file) === '.claude.json' && parsed.data.projects) {
        for (const [proj, pv] of Object.entries(parsed.data.projects)) {
          if (pv && pv.mcpServers && Object.keys(pv.mcpServers).length)
            groups.push({ harness: `Claude Code (${path.basename(proj) || proj})`, keyPath: ['projects', proj, 'mcpServers'] });
        }
      }
      for (const g of groups) {
        const obj = getAt(parsed.data, g.keyPath);
        found.push({ harness: g.harness, file, format: 'json', editable: parsed.editable, keyPath: g.keyPath,
          entries: Object.entries(obj).map(([name, v]) => ({ name, keyPath: g.keyPath, summary: summarize(v),
            nativeOff: !!(v && (v.disabled === true || v.enabled === false)) })) });
      }
    }
  }
  return found;
}

function scan() {
  const state = U.loadState();
  const servers = new Map();
  const harnesses = new Map();
  const get = (name) => {
    if (!servers.has(name)) servers.set(name, { name, installs: [] });
    return servers.get(name);
  };
  const addH = (h, file, d) => {
    const k = h + '|' + file;
    if (!harnesses.has(k)) harnesses.set(k, { id: k, label: h, file: U.rel(file), enabled: 0, disabled: 0 });
    harnesses.get(k)[d ? 'disabled' : 'enabled']++;
  };
  for (const c of configs()) {
    for (const e of c.entries) {
      get(e.name).installs.push({ harness: c.harness, hid: c.harness + '|' + c.file, file: U.rel(c.file), format: c.format,
        keyPath: e.keyPath, editable: c.editable, enabled: true, nativeOff: e.nativeOff, summary: e.summary });
      addH(c.harness, c.file, false);
    }
  }
  for (const r of state.disabledMcp) {
    get(r.name).installs.push({ harness: r.harness, hid: r.harness + '|' + r.file, file: U.rel(r.file), format: r.format,
      keyPath: r.keyPath, editable: true, enabled: false, summary: r.summary });
    addH(r.harness, r.file, true);
  }
  return {
    harnesses: [...harnesses.values()].sort((a, b) => a.label.localeCompare(b.label)),
    servers: [...servers.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function sameKey(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

function disableOne(state, harness, file, keyPath, name) {
  const text = fs.readFileSync(file, 'utf8');
  const rec = { harness, file, keyPath, name, format: null, value: null, text: null, summary: '', at: new Date().toISOString() };
  if (file.toLowerCase().endsWith('.toml')) {
    const { lines, blocks } = tomlBlocks(text);
    const b = blocks.get(name);
    if (!b) throw new Error('not found in ' + U.rel(file));
    rec.format = 'toml';
    rec.summary = b.summary;
    const drop = new Set();
    for (const [s, e] of b.ranges) for (let i = s; i < e; i++) drop.add(i);
    rec.text = b.ranges.map(([s, e]) => lines.slice(s, e).join('\n')).join('\n').replace(/\s+$/, '');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    U.backup(file);
    U.atomicWrite(file, lines.filter((_, i) => !drop.has(i)).join(eol));
  } else {
    const parsed = parseJson(text);
    if (!parsed || !parsed.editable) throw new Error('config has comments; edit it by hand');
    const obj = getAt(parsed.data, keyPath);
    if (!obj || !(name in obj)) throw new Error('not found in ' + U.rel(file));
    rec.format = 'json';
    rec.value = obj[name];
    rec.summary = summarize(obj[name]);
    delete obj[name];
    U.backup(file);
    U.atomicWrite(file, JSON.stringify(parsed.data, null, indentOf(text)) + (text.endsWith('\n') ? '\n' : ''));
  }
  state.disabledMcp.push(rec);
}

function enableOne(state, rec) {
  const text = fs.readFileSync(rec.file, 'utf8');
  if (rec.format === 'toml') {
    if (tomlBlocks(text).blocks.has(rec.name)) throw new Error('already present in ' + U.rel(rec.file));
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    U.backup(rec.file);
    U.atomicWrite(rec.file, text.replace(/\s*$/, '') + eol + eol + rec.text.split(/\r?\n/).join(eol) + eol);
  } else {
    const parsed = parseJson(text);
    if (!parsed || !parsed.editable) throw new Error('config has comments; edit it by hand');
    let obj = parsed.data;
    for (const k of rec.keyPath) obj = obj[k] = obj[k] && typeof obj[k] === 'object' ? obj[k] : {};
    if (rec.name in obj) throw new Error('already present in ' + U.rel(rec.file));
    obj[rec.name] = rec.value;
    U.backup(rec.file);
    U.atomicWrite(rec.file, JSON.stringify(parsed.data, null, indentOf(text)) + (text.endsWith('\n') ? '\n' : ''));
  }
  state.disabledMcp.splice(state.disabledMcp.indexOf(rec), 1);
}

// targets: [{ name, hid? }] where hid = "<harness>|<file>" (omit hid for every harness).
function setEnabled({ targets, enabled }) {
  const state = U.loadState();
  const res = { changed: 0, errors: [] };
  const all = configs();
  for (const t of targets || []) {
    if (enabled) {
      const recs = state.disabledMcp.filter((r) => r.name === t.name && (!t.hid || t.hid === r.harness + '|' + r.file));
      for (const r of recs) {
        try { enableOne(state, r); res.changed++; } catch (e) { res.errors.push(`${t.name} @ ${r.harness}: ${e.message}`); }
      }
    } else {
      for (const c of all) {
        if (t.hid && t.hid !== c.harness + '|' + c.file) continue;
        const e = c.entries.find((x) => x.name === t.name);
        if (!e) continue;
        if (!c.editable) { res.errors.push(`${t.name} @ ${c.harness}: ${c.format} config is read-only here; edit ${U.rel(c.file)} by hand`); continue; }
        try { disableOne(state, c.harness, c.file, e.keyPath, t.name); res.changed++; } catch (err) { res.errors.push(`${t.name} @ ${c.harness}: ${err.message}`); }
      }
    }
  }
  U.logOp(state, { op: enabled ? 'mcp-enable' : 'mcp-disable', targets, changed: res.changed });
  U.saveState(state);
  return res;
}

// ---------- install a new server (used by .mcpb installs) ----------
function tomlStr(s) { return JSON.stringify(String(s)); }
function tomlKey(k) { return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlStr(k); }

function serverToToml(name, v) {
  const lines = [`[mcp_servers.${tomlKey(name)}]`];
  if (v.url) lines.push(`url = ${tomlStr(v.url)}`);
  if (v.command) lines.push(`command = ${tomlStr(v.command)}`);
  if (Array.isArray(v.args) && v.args.length) lines.push(`args = [${v.args.map(tomlStr).join(', ')}]`);
  if (v.env && Object.keys(v.env).length) {
    lines.push('', `[mcp_servers.${tomlKey(name)}.env]`);
    for (const [k, x] of Object.entries(v.env)) lines.push(`${tomlKey(k)} = ${tomlStr(x)}`);
  }
  return lines.join('\n');
}

// Writable install targets: every editable config that already exists, plus well-known defaults.
function installTargets() {
  const out = [];
  const seen = new Set();
  for (const c of configs()) {
    if (!c.editable) continue;
    const id = c.harness + '|' + c.file;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, harness: c.harness, file: c.file, rel: U.rel(c.file), format: c.format, keyPath: c.keyPath || null });
  }
  const defaults = [['Claude Code', path.join(U.HOME, '.claude.json'), ['mcpServers']],
    ['Claude Desktop', path.join(P.appData(), 'Claude', 'claude_desktop_config.json'), ['mcpServers']],
    ['Cursor', path.join(U.HOME, '.cursor', 'mcp.json'), ['mcpServers']],
    ['Gemini CLI', path.join(U.HOME, '.gemini', 'settings.json'), ['mcpServers']],
    ['Codex', path.join(U.HOME, '.codex', 'config.toml'), null]];
  for (const [harness, file, keyPath] of defaults) {
    if (out.some((o) => o.file === file)) continue;
    out.push({ id: harness + '|' + file, harness, file, rel: U.rel(file), format: file.endsWith('.toml') ? 'toml' : 'json', keyPath });
  }
  return out;
}

function addServer({ file, keyPath, name, value }) {
  if (!U.isUnderHome(file)) throw new Error('config must be under your home folder');
  const exists = fs.existsSync(file);
  const text = exists ? fs.readFileSync(file, 'utf8') : '';
  if (file.toLowerCase().endsWith('.toml')) {
    if (tomlBlocks(text).blocks.has(name)) throw new Error(`a server named "${name}" already exists in ${U.rel(file)}`);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    if (exists) U.backup(file);
    U.ensureDir(path.dirname(file));
    const head = text.replace(/\s*$/, '');
    U.atomicWrite(file, (head ? head + eol + eol : '') + serverToToml(name, value).split('\n').join(eol) + eol);
  } else {
    const parsed = exists && text.trim() ? parseJson(text) : { data: {}, editable: true };
    if (!parsed || !parsed.editable) throw new Error('config has comments; edit it by hand');
    let obj = parsed.data;
    for (const k of keyPath || ['mcpServers']) obj = obj[k] = obj[k] && typeof obj[k] === 'object' ? obj[k] : {};
    if (name in obj) throw new Error(`a server named "${name}" already exists in ${U.rel(file)}`);
    obj[name] = value;
    if (exists) U.backup(file);
    U.ensureDir(path.dirname(file));
    U.atomicWrite(file, JSON.stringify(parsed.data, null, exists ? indentOf(text) : 2) + '\n');
  }
  return { file: U.rel(file), name };
}

module.exports = { scan, setEnabled, tomlBlocks, stripJsonc, parseJson, sameKey, configs, installTargets, addServer, serverToToml, sourceFiles, getAt, indentOf };
