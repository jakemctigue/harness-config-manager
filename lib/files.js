'use strict';
// Config files that steer how each harness behaves: settings JSON (incl. ~/.claude.json), YAML,
// TOML, instruction Markdown (CLAUDE.md, AGENTS.md, GEMINI.md...), .env files and the flat text
// files inside skills. Read, validate, edit (with backup and conflict check), enable/disable
// instruction files, toggle .env variables, and ask Claude Code to diagnose a file.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const U = require('./util');
const P = require('./platform');
const mcp = require('./mcp');
const skills = require('./skills');

const TEXT_EXT = /\.(json|jsonc|json5|ya?ml|toml|md|markdown|mdx|txt|env|ini|cfg|conf|rules|prompt|mdc|xml|csv|tsv|sh|ps1|py|js|mjs|cjs|ts)$/i;
const CONFIG_EXT = /\.(json|jsonc|ya?ml|toml|md|markdown|mdc|env|ini|rules)$/i;
const INSTRUCTION = /^(CLAUDE|AGENTS?|GEMINI|CODEX|COPILOT|QWEN|CRUSH|WARP|CONVENTIONS|RULES|SYSTEM|BOOST|RTK)(\.local)?\.md$/i;
const SKIP_NAME = /(\.status\.|last-update|history|session|statsig|telemetry|cache|log|stats|lock|usage|state|census|footprint|tokens?|credentials|auth|cookie|device|remembered|\.backup|\.bak|-backup|ccr-backup|skm-tmp)/i;
const DISABLED_SUFFIX = '.skm-disabled';
const MAX_EDIT = 4 * 1024 * 1024;

function listDir(p) { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } }
function statOf(p) { try { return fs.statSync(p); } catch { return null; } }

const HARNESS_DIRS = {
  '.claude': 'Claude Code', '.codex': 'Codex', '.gemini': 'Gemini CLI', '.cursor': 'Cursor', '.codeium': 'Windsurf',
  '.copilot': 'GitHub Copilot', '.kiro': 'Kiro', '.qwen': 'Qwen Code', '.factory': 'Factory Droid', '.continue': 'Continue',
  '.roo': 'Roo Code', '.kilocode': 'Kilo Code', '.augment': 'Augment', '.trae': 'Trae', '.qoder': 'Qoder', '.pi': 'Pi agent',
  '.hermes': 'Hermes', '.grok': 'Grok', '.junie': 'Junie', '.devin': 'Devin', '.lmstudio': 'LM Studio', '.crush': 'Crush',
  '.agents': 'Shared agents store', '.windsurf': 'Windsurf',
};

function classify(file) {
  const base = path.basename(file).replace(DISABLED_SUFFIX, '');
  if (/^\.env(\..+)?$/i.test(base) || /\.env$/i.test(base)) return 'env';
  if (INSTRUCTION.test(base) || /\.(md|markdown|mdc|rules)$/i.test(base)) return 'instructions';
  return 'settings';
}

function harnessFor(file) {
  const r = path.relative(U.HOME, file).split(path.sep);
  if (HARNESS_DIRS[r[0]]) return HARNESS_DIRS[r[0]];
  if (r[0] === '.config' && r[1]) return r[1].charAt(0).toUpperCase() + r[1].slice(1);
  const ad = path.relative(U.HOME, P.appData()).split(path.sep).join('/');
  const rr = r.join('/');
  if (rr.startsWith(ad + '/Claude/')) return 'Claude Desktop';
  if (rr.startsWith(ad + '/Code/')) return 'VS Code';
  if (rr.startsWith(ad + '/Zed/')) return 'Zed';
  if (r.length === 1) return 'Home';
  if (r[0].startsWith('.') && r[0].length > 1) return r[0].charAt(1).toUpperCase() + r[0].slice(2);
  return 'Other';
}

// All the harness-level config files on this machine.
function discover() {
  const out = new Map();
  const add = (file, extra = {}) => {
    const st = statOf(file);
    if (!st || !st.isFile()) return;
    const key = P.IS_WIN || P.IS_MAC ? file.toLowerCase() : file;
    if (out.has(key)) return;
    const disabled = file.endsWith(DISABLED_SUFFIX);
    out.set(key, Object.assign({ path: file, rel: U.rel(file), name: path.basename(file).replace(DISABLED_SUFFIX, ''),
      kind: classify(file), harness: harnessFor(file), size: st.size, mtime: st.mtimeMs, disabled }, extra));
  };
  // home-level files
  for (const f of ['.claude.json', 'CLAUDE.md', 'AGENTS.md', 'AGENT.md', 'GEMINI.md', '.env', '.mcp.json']) add(path.join(U.HOME, f));
  for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) add(path.join(U.HOME, f + DISABLED_SUFFIX));
  // every MCP source
  for (const [, f] of mcp.sourceFiles()) add(f);
  // ~/.<harness>/ (depth 1, plus a few known subfolders)
  for (const top of listDir(U.HOME)) {
    if (!top.isDirectory() || !top.name.startsWith('.') || ['.skill-manager', '.cache', '.npm', '.nuget', '.cargo', '.rustup', '.git', '.vscode', '.vexp', '.codegraph'].includes(top.name)) continue;
    const d = path.join(U.HOME, top.name);
    const isHarness = !!HARNESS_DIRS[top.name] || listDir(d).some((e) => e.name === 'skills' || e.name === 'settings.json' || e.name === 'config.toml');
    if (!isHarness) continue;
    const scanDir = (dir, depth) => {
      for (const e of listDir(dir)) {
        const p = path.join(dir, e.name);
        if (e.isFile()) {
          const n = e.name.replace(DISABLED_SUFFIX, '');
          if (!(CONFIG_EXT.test(n) || /^\.env/i.test(n))) continue;
          if (SKIP_NAME.test(n) && !INSTRUCTION.test(n)) continue;
          add(p);
        } else if (e.isDirectory() && depth > 0 && ['rules', 'agents', 'commands', 'hooks', 'output-styles', 'prompts', 'settings', 'config', 'policies'].includes(e.name)) {
          scanDir(p, depth - 1);
        }
      }
    };
    scanDir(d, 1);
  }
  // ~/.config/<app>/ for XDG-style harnesses
  for (const app of ['opencode', 'crush', 'goose', 'amp', 'zed', 'devin', 'agents']) {
    for (const e of listDir(path.join(U.HOME, '.config', app))) {
      if (e.isFile() && (CONFIG_EXT.test(e.name) || /^\.env/.test(e.name)) && !SKIP_NAME.test(e.name)) add(path.join(U.HOME, '.config', app, e.name));
    }
  }
  // Claude Desktop config files
  for (const f of ['claude_desktop_config.json', 'config.json', 'developer_settings.json', 'extensions-installations.json', 'mcp-user-tool-toggles.json']) {
    add(path.join(P.appData(), 'Claude', f));
  }
  return [...out.values()].sort((a, b) => a.harness.localeCompare(b.harness) || a.name.localeCompare(b.name));
}

// Text files inside one skill (store copy or the first real folder).
function skillFiles(name) {
  const s = skills.scan().skills.find((x) => x.name === name);
  if (!s) throw new Error('skill not found');
  const roots = [];
  if (s.inStore) roots.push(path.join(U.STORE, name));
  for (const i of s.installs) if (i.enabled && i.kind === 'dir') roots.push(path.join(U.HOME, i.path.replace(/^~\//, '')));
  const files = [];
  const seen = new Set();
  for (const root of roots) {
    const walk = (dir, depth) => {
      for (const e of listDir(dir)) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === '__pycache__') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth < 4) walk(p, depth + 1);
        else if (e.isFile() && (TEXT_EXT.test(e.name.replace(DISABLED_SUFFIX, '')) || /^\.env/i.test(e.name))) {
          const real = (() => { try { return fs.realpathSync(p); } catch { return p; } })();
          if (seen.has(real)) continue;
          seen.add(real);
          const st = statOf(p);
          files.push({ path: p, rel: U.rel(p), name: path.relative(root, p).split(path.sep).join('/'), kind: classify(p),
            harness: 'Skill: ' + name, size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0, disabled: p.endsWith(DISABLED_SUFFIX), root: U.rel(root) });
        }
      }
    };
    walk(root, 0);
  }
  return files;
}

// ---------- access control ----------
function resolveUserPath(p) {
  const abs = path.resolve(String(p).replace(/^~[\\/]/, U.HOME + path.sep));
  if (!U.isUnderHome(abs)) throw new Error('path outside home');
  const base = path.basename(abs).replace(DISABLED_SUFFIX, '');
  if (!(TEXT_EXT.test(base) || /^\.env/i.test(base) || base === '.claude.json')) throw new Error('not a text config file');
  return abs;
}

function read(p) {
  const abs = resolveUserPath(p);
  const st = fs.statSync(abs);
  if (st.size > MAX_EDIT) throw new Error('file is larger than 4 MB; open it in an editor');
  return { path: U.rel(abs), text: fs.readFileSync(abs, 'utf8'), mtime: st.mtimeMs, kind: classify(abs), size: st.size };
}

function write({ path: p, text, mtime }) {
  const abs = resolveUserPath(p);
  const st = statOf(abs);
  if (st && mtime && Math.abs(st.mtimeMs - mtime) > 1) throw new Error('the file changed on disk since you opened it; reopen it and reapply your edit');
  if (st) U.backup(abs);
  U.ensureDir(path.dirname(abs));
  U.atomicWrite(abs, text);
  const state = U.loadState();
  U.logOp(state, { op: 'file-save', path: U.rel(abs) });
  U.saveState(state);
  return { ok: true, mtime: fs.statSync(abs).mtimeMs, checks: check(abs, text) };
}

// Instruction / text files are disabled by renaming them aside (harnesses then ignore them).
function setEnabled({ path: p, enabled }) {
  const abs = resolveUserPath(p);
  const on = abs.endsWith(DISABLED_SUFFIX) ? abs.slice(0, -DISABLED_SUFFIX.length) : abs;
  const off = on + DISABLED_SUFFIX;
  const [from, to] = enabled ? [off, on] : [on, off];
  if (!fs.existsSync(from)) throw new Error('file not found');
  if (fs.existsSync(to)) throw new Error(U.rel(to) + ' already exists');
  fs.renameSync(from, to);
  const state = U.loadState();
  U.logOp(state, { op: enabled ? 'file-enable' : 'file-disable', path: U.rel(on) });
  U.saveState(state);
  return { changed: 1, errors: [], path: U.rel(to) };
}

// ---------- .env ----------
const SECRET = /(key|token|secret|password|passwd|pwd|auth|credential|cookie|session|private)/i;
function mask(k, v) {
  if (!SECRET.test(k) || !v) return v;
  return v.length <= 8 ? '•'.repeat(v.length) : v.slice(0, 3) + '…' + v.slice(-2) + ` (${v.length} chars)`;
}

function parseEnv(text) {
  const vars = [];
  text.split(/\r?\n/).forEach((line, i) => {
    let m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    let disabled = false;
    if (!m) { m = line.match(/^\s*#\s*(?:skm-off:\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); disabled = !!m; }
    if (!m) return;
    let v = m[2].trim();
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    vars.push({ line: i, key: m[1], value: v, disabled });
  });
  return vars;
}

// Every variable from every .env file plus Claude Code's settings.json "env" block, values masked.
function envScan() {
  const files = discover().filter((f) => f.kind === 'env');
  for (const s of skills.scan().skills) {
    if (!s.inStore) continue;
    for (const e of listDir(path.join(U.STORE, s.name))) {
      if (e.isFile() && /^\.env/i.test(e.name)) files.push({ path: path.join(U.STORE, s.name, e.name), rel: U.rel(path.join(U.STORE, s.name, e.name)), harness: 'Skill: ' + s.name, kind: 'env' });
    }
  }
  const vars = [];
  for (const f of files) {
    let text; try { text = fs.readFileSync(f.path, 'utf8'); } catch { continue; }
    for (const v of parseEnv(text)) vars.push({ source: f.rel, harness: f.harness, type: 'dotenv', key: v.key, value: mask(v.key, v.value), enabled: !v.disabled, line: v.line });
  }
  const settingsFile = path.join(U.HOME, '.claude', 'settings.json');
  const st = mcp.parseJson((() => { try { return fs.readFileSync(settingsFile, 'utf8'); } catch { return '{}'; } })());
  if (st && st.data) {
    for (const [k, v] of Object.entries(st.data.env || {})) vars.push({ source: U.rel(settingsFile), harness: 'Claude Code', type: 'settings', key: k, value: mask(k, String(v)), enabled: true });
    for (const [k, v] of Object.entries(st.data.envDisabledBySkm || {})) vars.push({ source: U.rel(settingsFile), harness: 'Claude Code', type: 'settings', key: k, value: mask(k, String(v)), enabled: false });
  }
  return { files: files.map((f) => ({ rel: f.rel, harness: f.harness })), vars };
}

// Toggle or set one variable. dotenv: comment/uncomment. settings: move between env and envDisabledBySkm.
function envSet({ source, key, enabled, value }) {
  const abs = resolveUserPath(source);
  const text = fs.readFileSync(abs, 'utf8');
  if (abs.endsWith('settings.json')) {
    const parsed = mcp.parseJson(text);
    if (!parsed || !parsed.editable) throw new Error('settings.json has comments or is invalid');
    const d = parsed.data;
    d.env = d.env || {};
    const offKey = 'envDisabledBySkm';
    if (value !== undefined) { (key in (d[offKey] || {}) ? d[offKey] : d.env)[key] = String(value); }
    if (enabled !== undefined) {
      const from = enabled ? (d[offKey] || {}) : d.env;
      if (!(key in from)) throw new Error(key + ' not found');
      const v = from[key];
      delete from[key];
      if (enabled) d.env[key] = v; else (d[offKey] = d[offKey] || {})[key] = v;
      if (d[offKey] && !Object.keys(d[offKey]).length) delete d[offKey];
    }
    U.backup(abs);
    U.atomicWrite(abs, JSON.stringify(d, null, mcp.indentOf(text)) + '\n');
    return { changed: 1, errors: [] };
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const vars = parseEnv(text).filter((v) => v.key === key);
  if (!vars.length && value !== undefined) lines.push(`${key}=${value}`);
  else if (!vars.length) throw new Error(key + ' not found');
  for (const v of vars) {
    let body = lines[v.line].replace(/^\s*#\s*(skm-off:\s*)?/, '');
    if (value !== undefined) body = body.replace(/=.*$/, '=' + (/\s|#/.test(value) ? JSON.stringify(value) : value));
    const on = enabled === undefined ? !v.disabled : enabled;
    lines[v.line] = on ? body : '# skm-off: ' + body;
  }
  U.backup(abs);
  U.atomicWrite(abs, lines.join(eol));
  return { changed: 1, errors: [] };
}

// ---------- checks ----------
function lineCol(text, pos) {
  const before = text.slice(0, pos);
  return { line: before.split('\n').length, col: pos - before.lastIndexOf('\n') };
}

function exeExists(cmd, env) {
  if (!cmd) return false;
  if (/[\\/]/.test(cmd)) return fs.existsSync(cmd) || (P.IS_WIN && ['.exe', '.cmd', '.bat'].some((e) => fs.existsSync(cmd + e)));
  return !!P.which(cmd, env);
}

function checkServers(servers, issues, where, env) {
  for (const [name, v] of Object.entries(servers || {})) {
    if (!v || typeof v !== 'object') { issues.push({ level: 'error', msg: `${where}: server "${name}" is not an object` }); continue; }
    const url = v.url || v.serverUrl || v.httpUrl;
    if (url) { try { new URL(url); } catch { issues.push({ level: 'error', msg: `${where}: server "${name}" has an invalid URL: ${url}` }); } continue; }
    // Zed: { command: { path, args } } or an extension-provided server with only "settings"
    const cmd = Array.isArray(v.command) ? v.command[0] : v.command && typeof v.command === 'object' ? v.command.path : v.command;
    if (!cmd && (v.source === 'extension' || v.settings || v.type === 'extension')) continue;
    if (!cmd) { issues.push({ level: 'error', msg: `${where}: server "${name}" has neither "command" nor "url"` }); continue; }
    if (!exeExists(cmd, env) && !(/\s/.test(cmd) && exeExists(cmd.split(/\s/)[0], env))) issues.push({ level: 'warn', msg: `${where}: server "${name}" runs "${cmd}", which is not on PATH or does not exist` });
    for (const a of v.args || []) {
      if (typeof a === 'string' && /^([A-Za-z]:[\\/]|\/)/.test(a) && /\.(js|mjs|cjs|py|exe|ts)$/i.test(a) && !fs.existsSync(a)) {
        issues.push({ level: 'warn', msg: `${where}: server "${name}" points at a missing file: ${a}` });
      }
    }
    for (const [k, x] of Object.entries(v.env || {})) {
      if (x === '' || x == null) issues.push({ level: 'info', msg: `${where}: server "${name}" has an empty env var ${k}` });
      if (typeof x === 'string' && /\$\{user_config\./.test(x)) issues.push({ level: 'warn', msg: `${where}: server "${name}" has an unresolved placeholder in ${k}` });
    }
  }
}

function checkJson(file, text, issues) {
  const parsed = mcp.parseJson(text);
  if (!parsed) {
    if (!text.trim()) { issues.push({ level: 'warn', msg: 'File is empty; a harness that expects JSON here may fail to start. Use {} for an empty config.' }); return; }
    try { JSON.parse(text); } catch (e) {
      const m = e.message.match(/position (\d+)/);
      const lc = m ? lineCol(text, Number(m[1])) : null;
      issues.push({ level: 'error', msg: 'Invalid JSON' + (lc ? ` at line ${lc.line}, column ${lc.col}` : '') + ': ' + e.message.replace(/^JSON\.parse: /, '') });
    }
    return;
  }
  if (!parsed.editable) issues.push({ level: 'info', msg: 'Contains comments or trailing commas (JSONC). Harnesses that expect strict JSON will fail to read it.' });
  const d = parsed.data;
  const base = path.basename(file);
  const env = P.freshEnv();
  for (const k of ['mcpServers', 'servers', 'context_servers', 'mcp_servers']) if (d[k] && typeof d[k] === 'object') checkServers(d[k], issues, k, env);
  if (d.mcp && typeof d.mcp === 'object' && !Array.isArray(d.mcp)) {
    if (d.mcp.servers && typeof d.mcp.servers === 'object') checkServers(d.mcp.servers, issues, 'mcp.servers', env);
    else checkServers(d.mcp, issues, 'mcp', env);
  }
  if (base === '.claude.json') {
    const size = Buffer.byteLength(text);
    if (size > 5 * 1024 * 1024) issues.push({ level: 'warn', msg: `~/.claude.json is ${(size / 1048576).toFixed(1)} MB. Claude Code rewrites it often, so a large file slows startup; old "projects" entries can be pruned.` });
    const projects = Object.entries(d.projects || {});
    const gone = projects.filter(([p]) => /^([A-Za-z]:|\/)/.test(p) && !fs.existsSync(p));
    if (gone.length) issues.push({ level: 'info', msg: `${gone.length} project entr${gone.length === 1 ? 'y points' : 'ies point'} at folders that no longer exist (e.g. ${gone.slice(0, 3).map(([p]) => p).join(', ')}).` });
    for (const [p, pv] of projects) if (pv && pv.mcpServers) checkServers(pv.mcpServers, issues, `projects["${path.basename(p)}"].mcpServers`, env);
  }
  if (/settings(\.local)?\.json$/.test(base) && file.includes('.claude')) {
    for (const [k, v] of Object.entries(d.enabledPlugins || {})) if (typeof v !== 'boolean') issues.push({ level: 'error', msg: `enabledPlugins["${k}"] must be true or false` });
    const perms = d.permissions || {};
    for (const list of ['allow', 'deny', 'ask']) {
      if (perms[list] && !Array.isArray(perms[list])) issues.push({ level: 'error', msg: `permissions.${list} must be an array` });
      for (const r of perms[list] || []) if (typeof r !== 'string' || !/^[A-Za-z_][\w-]*(__[\w-]+)*(\(.*\))?$|^mcp__/.test(r)) issues.push({ level: 'warn', msg: `permissions.${list} has an unusual rule: ${JSON.stringify(r)}` });
    }
    if (perms.allow && perms.deny) for (const r of perms.allow) if (perms.deny.includes(r)) issues.push({ level: 'warn', msg: `"${r}" is in both permissions.allow and permissions.deny (deny wins)` });
    for (const [k, v] of Object.entries(d.env || {})) if (typeof v !== 'string') issues.push({ level: 'error', msg: `env.${k} must be a string (got ${typeof v})` });
    for (const [event, groups] of Object.entries(d.hooks || {})) {
      if (!Array.isArray(groups)) { issues.push({ level: 'error', msg: `hooks.${event} must be an array` }); continue; }
      for (const g of groups) for (const h of (g && g.hooks) || []) {
        if (h.type === 'command' && h.command) {
          const first = (h.command.match(/^"([^"]+)"|^(\S+)/) || [])[1] || (h.command.match(/^(\S+)/) || [])[1];
          const p = first && first.replace(/^~(?=[\\/])/, U.HOME);
          if (p && /^([A-Za-z]:[\\/]|\/|~)/.test(first) && !fs.existsSync(p)) issues.push({ level: 'warn', msg: `hooks.${event}: command starts with a missing file: ${first}` });
          else if (first && !/[\\/$%]/.test(first) && !['echo', 'cd', 'set', 'export', 'if', 'test', '['].includes(first) && !exeExists(first, env)) issues.push({ level: 'warn', msg: `hooks.${event}: "${first}" is not on PATH` });
        }
      }
    }
    if (d.statusLine && d.statusLine.command) {
      const first = (d.statusLine.command.match(/^"([^"]+)"|^(\S+)/) || []).slice(1).find(Boolean);
      if (first && /^([A-Za-z]:[\\/]|\/)/.test(first) && !fs.existsSync(first)) issues.push({ level: 'warn', msg: `statusLine.command points at a missing file: ${first}` });
    }
  }
}

function checkToml(text, issues) {
  const seen = new Map();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) return;
    if (line.startsWith('[')) {
      if (!/^\[\[?[^\[\]]+\]\]?$/.test(line)) issues.push({ level: 'error', msg: `line ${i + 1}: malformed table header: ${raw.trim()}` });
      else if (line.startsWith('[[')) {
        // a new array element starts fresh sub-tables: [[providers]] ... [providers.x] may repeat
        const prefix = '[' + line.slice(2, -2).trim() + '.';
        for (const k of [...seen.keys()]) if (k.startsWith(prefix)) seen.delete(k);
      } else {
        if (seen.has(line)) issues.push({ level: 'error', msg: `line ${i + 1}: table ${line} is defined twice (first at line ${seen.get(line)})` });
        seen.set(line, i + 1);
      }
      return;
    }
    if (!/^("[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)(\s*\.\s*("[^"]*"|[A-Za-z0-9_-]+))*\s*=/.test(line) && !/^[\]}),"'\d-]/.test(line)) {
      issues.push({ level: 'warn', msg: `line ${i + 1}: does not look like key = value: ${raw.trim().slice(0, 80)}` });
    }
  });
  const { blocks } = mcp.tomlBlocks(text);
  const env = P.freshEnv();
  for (const b of blocks.values()) {
    const cmd = b.command;
    if (cmd && !exeExists(cmd, env) && !exeExists(cmd.split(/\s/)[0], env)) issues.push({ level: 'warn', msg: `mcp_servers.${b.name} runs "${cmd}", which is not on PATH` });
  }
}

function checkYaml(text, issues) {
  text.split(/\r?\n/).forEach((l, i) => {
    if (/^\t+/.test(l) || /^ +\t/.test(l)) issues.push({ level: 'error', msg: `line ${i + 1}: YAML does not allow tabs for indentation` });
    if (/^\s*[^#\s][^:]*:[^\s/]/.test(l) && !/https?:|[{\["']/.test(l) && !/:\d/.test(l)) issues.push({ level: 'info', msg: `line ${i + 1}: missing space after ":"?` });
  });
}

function checkMarkdown(file, text, issues) {
  const base = path.basename(file).replace(DISABLED_SUFFIX, '');
  if (/^skill\.md$/i.test(base)) {
    const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) issues.push({ level: 'error', msg: 'SKILL.md has no YAML frontmatter (--- name / description ---); most harnesses will not load it' });
    else {
      const name = (m[1].match(/^name:\s*(.+)$/m) || [])[1];
      const desc = (m[1].match(/^description:\s*(.*)$/m) || [])[1];
      if (!name) issues.push({ level: 'error', msg: 'frontmatter is missing "name"' });
      else if (name.trim().replace(/^["']|["']$/g, '') !== path.basename(path.dirname(file))) issues.push({ level: 'warn', msg: `name "${name.trim()}" does not match the folder name "${path.basename(path.dirname(file))}"` });
      if (desc === undefined) issues.push({ level: 'error', msg: 'frontmatter is missing "description" (agents use it to decide when to load the skill)' });
      else {
        const full = m[1].slice(m[1].indexOf('description:')).split(/\r?\n(?=\S)/)[0];
        if (full.length > 1100) issues.push({ level: 'warn', msg: `description is ${full.length} characters; the limit in Claude Code is 1024` });
      }
    }
  }
  if (Buffer.byteLength(text) > 40000 && (INSTRUCTION.test(base) || /\.(mdc|rules)$/i.test(base))) issues.push({ level: 'warn', msg: `${base} is ${Math.round(Buffer.byteLength(text) / 1000)} KB; it is loaded into context every session, which costs tokens` });
  const dir = path.dirname(file);
  for (const m of text.matchAll(/(?:^|\s)@((?:~|\.{1,2})?[\\/]?[\w.\-\\/]+\.(?:md|txt|json))/g)) {
    const p = m[1].startsWith('~') ? path.join(U.HOME, m[1].slice(1)) : path.resolve(dir, m[1]);
    if (!fs.existsSync(p)) issues.push({ level: 'warn', msg: `@import ${m[1]} points at a missing file` });
  }
  for (const m of text.matchAll(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g)) {
    const p = path.resolve(dir, decodeURIComponent(m[1].split('#')[0]));
    if (m[1] && !fs.existsSync(p)) issues.push({ level: 'info', msg: `link to missing file: ${m[1]}` });
  }
}

function checkEnv(text, issues) {
  const seen = new Map();
  text.split(/\r?\n/).forEach((l, i) => {
    if (!l.trim() || /^\s*#/.test(l)) return;
    const m = l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)(\s*)=(\s*)(.*)$/);
    if (!m) { issues.push({ level: 'error', msg: `line ${i + 1}: not KEY=value` }); return; }
    if (m[2] || m[3]) issues.push({ level: 'warn', msg: `line ${i + 1}: spaces around "=" are not supported by every loader` });
    if (/\s/.test(m[4]) && !/^(['"]).*\1\s*(#.*)?$/.test(m[4]) && !/\s#/.test(m[4])) issues.push({ level: 'warn', msg: `line ${i + 1}: ${m[1]} has spaces; quote the value` });
    if (seen.has(m[1])) issues.push({ level: 'warn', msg: `line ${i + 1}: ${m[1]} is already set on line ${seen.get(m[1])}; the later value usually wins` });
    seen.set(m[1], i + 1);
  });
}

function check(abs, text) {
  const issues = [];
  const base = path.basename(abs).replace(DISABLED_SUFFIX, '');
  try {
    if (/\.(json|jsonc|json5)$/i.test(base) || base === '.claude.json') checkJson(abs, text, issues);
    else if (/\.toml$/i.test(base)) checkToml(text, issues);
    else if (/\.ya?ml$/i.test(base)) checkYaml(text, issues);
    else if (/\.(md|markdown|mdc|mdx)$/i.test(base)) checkMarkdown(abs, text, issues);
    else if (classify(abs) === 'env') checkEnv(text, issues);
  } catch (e) { issues.push({ level: 'error', msg: 'check failed: ' + e.message }); }
  return issues;
}

function checkFile({ path: p, text }) {
  const abs = resolveUserPath(p);
  return { issues: check(abs, text !== undefined ? text : fs.readFileSync(abs, 'utf8')) };
}

// Run the checks over every discovered config file and every SKILL.md (the "Health" overview).
function checkAll() {
  const out = [];
  for (const f of discover()) {
    if (f.size > MAX_EDIT || f.disabled) continue;
    let text; try { text = fs.readFileSync(f.path, 'utf8'); } catch { continue; }
    const issues = check(f.path, text).filter((i) => i.level !== 'info');
    if (issues.length) out.push({ path: f.rel, harness: f.harness, issues });
  }
  for (const s of skills.scan().skills) {
    if (!s.inStore || s.trashed) continue;
    const p = ['SKILL.md', 'skill.md'].map((n) => path.join(U.STORE, s.name, n)).find((x) => fs.existsSync(x));
    if (!p) continue;
    const issues = check(p, fs.readFileSync(p, 'utf8')).filter((i) => i.level === 'error');
    if (issues.length) out.push({ path: U.rel(p), harness: 'Skill: ' + s.name, issues });
  }
  return { files: out };
}

// ---------- diagnose with Claude Code ----------
function redact(text, kind) {
  if (kind === 'env') return text.replace(/^(\s*(?:#\s*)?(?:export\s+)?[A-Za-z_][\w.-]*\s*=\s*)(.+)$/gm, (all, k, v) => k + (v.trim() ? '<redacted>' : ''));
  return text
    .replace(/("[^"]*(?:key|token|secret|password|passwd|auth|credential|cookie|session)[^"]*"\s*:\s*)"[^"]*"/gi, '$1"<redacted>"')
    .replace(/^(\s*[\w.-]*(?:key|token|secret|password|auth|credential)[\w.-]*\s*[=:]\s*)(["']?).+?\2\s*$/gim, '$1"<redacted>"')
    .replace(/\b(sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g, '<redacted>');
}

function findClaude(env) {
  const p = P.which('claude', env);
  if (p) return p;
  const cands = [path.join(U.HOME, '.local', 'bin', P.IS_WIN ? 'claude.exe' : 'claude'), path.join(U.HOME, '.claude', 'local', P.IS_WIN ? 'claude.exe' : 'claude')];
  return cands.find((c) => fs.existsSync(c)) || null;
}

function diagnose({ path: p, text, question, deep }) {
  const abs = resolveUserPath(p);
  const kind = classify(abs);
  const body = text !== undefined ? text : fs.readFileSync(abs, 'utf8');
  const issues = check(abs, body);
  const env = P.freshEnv();
  const exe = findClaude(env);
  if (!exe) return Promise.reject(new Error('Claude Code (the "claude" command) is not installed or not on PATH'));
  const prompt = [
    `You are diagnosing a configuration file for an AI coding harness on ${P.osName()}.`,
    `File: ${U.rel(abs)} (harness: ${harnessFor(abs)}, type: ${kind}).`,
    'Find anything wrong or risky: syntax errors, wrong keys or types, settings the harness does not support, missing commands or paths, conflicting rules, duplicated entries, and instructions that would confuse an agent.',
    deep ? 'You may use Read, Glob and Grep to check referenced files and paths. Do not modify anything.' : 'Answer from the file alone without using tools; be quick and concrete.',
    'Answer in Markdown: a short verdict, then a numbered list of problems with the exact fix for each.',
    'If the file needs changes, end with the complete corrected file in ONE fenced code block whose info string is "fixed" (```fixed). Keep every value exactly as given, including "<redacted>" placeholders, which stand for secrets you cannot see.',
    issues.length ? 'Local checks already found:\n' + issues.map((i) => `- [${i.level}] ${i.msg}`).join('\n') : 'Local checks found nothing.',
    question ? 'The user also asks: ' + question : '',
    '', '--- FILE START ---', redact(body, kind).slice(0, 150000), '--- FILE END ---',
  ].filter(Boolean).join('\n');
  return new Promise((resolve, reject) => {
    // Read-only tools only, and no MCP servers (they slow startup and are not needed to review a file).
    const args = ['-p', '--output-format', 'text', '--no-session-persistence', '--strict-mcp-config', '--permission-mode', 'default',
      ...(deep ? ['--tools', 'Read,Glob,Grep', '--allowedTools', 'Read', 'Glob', 'Grep'] : ['--tools', '', '--effort', 'low'])];
    const child = spawn(exe, args, { cwd: path.dirname(abs), env, windowsHide: true, shell: P.IS_WIN && /\.(cmd|bat)$/i.test(exe) });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Claude Code took longer than 6 minutes')); }, 360000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) return reject(new Error((err || `claude exited with code ${code}`).trim().slice(0, 600)));
      const m = out.match(/```fixed\r?\n([\s\S]*?)\r?\n```/);
      resolve({ report: out.trim(), fixed: m ? m[1] : null, redacted: /<redacted>/.test(m ? m[1] : ''), issues });
    });
    child.stdin.end(prompt);
  });
}

// Put real secret values back into a suggested fix that contains "<redacted>" placeholders,
// by matching each placeholder line to the original line with the same text before the value.
function restoreRedacted({ path: p, text, fixed }) {
  const abs = resolveUserPath(p);
  const src = text !== undefined ? text : fs.readFileSync(abs, 'utf8');
  const orig = src.split(/\r?\n/);
  const used = new Set();
  let unresolved = 0;
  const lines = fixed.split(/\r?\n/).map((l) => {
    if (!l.includes('<redacted>')) return l;
    const prefix = l.slice(0, l.indexOf('<redacted>')).replace(/"$/, '').trim();
    const idx = orig.findIndex((o, i) => !used.has(i) && o.trim().startsWith(prefix));
    if (idx < 0) { unresolved++; return l; }
    used.add(idx);
    return l.slice(0, l.length - l.trimStart().length) + orig[idx].trim();
  });
  return { text: lines.join(src.includes('\r\n') ? '\r\n' : '\n'), unresolved };
}

module.exports = { restoreRedacted, discover, skillFiles, read, write, setEnabled, envScan, envSet, parseEnv, check, checkFile, checkAll, diagnose, redact, classify, DISABLED_SUFFIX };

