'use strict';
// Running harnesses: detect them, and restart them with a freshly built environment so they pick
// up new env vars, skills, plugins, MCP servers and instruction files.
//   GUI apps (Claude Desktop, ChatGPT, Cursor, VS Code...)  close -> relaunch the same executable
//   CLIs (Claude Code, Codex, Gemini CLI...)                close -> reopen a terminal per instance
//                                                           running the resume command in its folder
const fs = require('fs');
const path = require('path');
const U = require('./util');
const P = require('./platform');

const W = P.IS_WIN, M = P.IS_MAC;
const LA = () => P.localAppData();
const norm = (s) => String(s || '').replace(/\\/g, '/').toLowerCase();

// match(p): p.exe / p.cmd / p.name are lower-cased with forward slashes.
const REGISTRY = [
  { id: 'claude-desktop', label: 'Claude Desktop', kind: 'gui', macApp: 'Claude',
    match: (p) => /\/(anthropicclaude|windowsapps\/claude_[^/]+)\/.*claude\.exe$/.test(p.exe) || /\/programs\/claude\/claude\.exe$/.test(p.exe)
      || /claude\.app\/contents\/macos\/claude$/.test(p.exe) || /\/(claude-desktop|claude_desktop)\b/.test(p.exe),
    paths: () => W ? [path.join(LA(), 'AnthropicClaude', 'claude.exe'), path.join(LA(), 'Programs', 'claude', 'Claude.exe')] : M ? [] : ['claude-desktop'],
    config: () => path.join(P.appData(), 'Claude') },
  { id: 'chatgpt', label: 'ChatGPT / Codex app', kind: 'gui', macApp: 'ChatGPT',
    match: (p) => /\/chatgpt\.exe$/.test(p.exe) || /chatgpt\.app\/contents\/macos\/chatgpt$/.test(p.exe),
    paths: () => W ? [path.join(LA(), 'Programs', 'ChatGPT', 'ChatGPT.exe')] : [], config: () => M ? '/Applications/ChatGPT.app' : null },
  { id: 'codex-app', label: 'Codex app', kind: 'gui', macApp: 'Codex',
    match: (p) => /\/codex\.app\/contents\/macos\/codex$/.test(p.exe) || /windowsapps\/openai\.codex[^/]*\/.*codex\.exe$/.test(p.exe),
    paths: () => [], config: () => M ? '/Applications/Codex.app' : null },
  { id: 'cursor', label: 'Cursor', kind: 'gui', macApp: 'Cursor',
    match: (p) => /\/cursor\.exe$/.test(p.exe) || /cursor\.app\/contents\/macos\/cursor$/.test(p.exe) || /\/(cursor|cursor\.appimage)$/.test(p.exe) && !/\/bin\//.test(p.exe),
    paths: () => W ? [path.join(LA(), 'Programs', 'cursor', 'Cursor.exe')] : M ? [] : ['cursor'], config: () => path.join(U.HOME, '.cursor') },
  { id: 'vscode', label: 'VS Code', kind: 'gui', macApp: 'Visual Studio Code',
    match: (p) => /\/microsoft vs code\/code\.exe$/.test(p.exe) || /visual studio code\.app\/contents\/macos\/(electron|code)$/.test(p.exe) || /\/(usr\/share\/code\/code|code\/code)$/.test(p.exe),
    paths: () => W ? [path.join(LA(), 'Programs', 'Microsoft VS Code', 'Code.exe'), path.join(process.env.ProgramFiles || 'C:/Program Files', 'Microsoft VS Code', 'Code.exe')] : M ? [] : ['code'],
    config: () => path.join(P.appData(), 'Code') },
  { id: 'vscode-insiders', label: 'VS Code Insiders', kind: 'gui', macApp: 'Visual Studio Code - Insiders',
    match: (p) => /code - insiders\.exe$/.test(p.exe) || /visual studio code - insiders\.app\//.test(p.exe) && /macos\//.test(p.exe),
    paths: () => W ? [path.join(LA(), 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe')] : M ? [] : ['code-insiders'],
    config: () => path.join(P.appData(), 'Code - Insiders') },
  { id: 'windsurf', label: 'Windsurf', kind: 'gui', macApp: 'Windsurf',
    match: (p) => /\/windsurf\.exe$/.test(p.exe) || /windsurf\.app\/contents\/macos\//.test(p.exe) || /\/windsurf\/windsurf$/.test(p.exe),
    paths: () => W ? [path.join(LA(), 'Programs', 'Windsurf', 'Windsurf.exe')] : M ? [] : ['windsurf'], config: () => path.join(U.HOME, '.codeium', 'windsurf') },
  { id: 'kiro', label: 'Kiro', kind: 'gui', macApp: 'Kiro',
    match: (p) => /\/kiro\.exe$/.test(p.exe) || /kiro\.app\/contents\/macos\//.test(p.exe),
    paths: () => W ? [path.join(LA(), 'Programs', 'Kiro', 'Kiro.exe')] : M ? [] : ['kiro'], config: () => path.join(U.HOME, '.kiro') },
  { id: 'antigravity', label: 'Antigravity', kind: 'gui', macApp: 'Antigravity',
    match: (p) => /\/antigravity\.exe$/.test(p.exe) || /antigravity\.app\/contents\/macos\//.test(p.exe),
    paths: () => W ? [path.join(LA(), 'Programs', 'Antigravity', 'Antigravity.exe')] : M ? [] : ['antigravity'], config: () => path.join(U.HOME, '.gemini', 'antigravity') },
  { id: 'trae', label: 'Trae', kind: 'gui', macApp: 'Trae',
    match: (p) => /\/trae\.exe$/.test(p.exe) || /trae\.app\/contents\/macos\//.test(p.exe),
    paths: () => W ? [path.join(LA(), 'Programs', 'Trae', 'Trae.exe')] : [], config: () => path.join(U.HOME, '.trae') },
  { id: 'zed', label: 'Zed', kind: 'gui', macApp: 'Zed',
    match: (p) => /\/zed\.exe$/.test(p.exe) || /zed\.app\/contents\/macos\/zed$/.test(p.exe) || /\/(zed|zed-editor)$/.test(p.exe) && !/cli/.test(p.exe),
    paths: () => W ? [path.join(LA(), 'Programs', 'Zed', 'zed.exe')] : M ? [] : ['zed', 'zeditor'], config: () => path.join(P.appData(), W ? 'Zed' : 'zed') },
  { id: 'lmstudio', label: 'LM Studio', kind: 'gui', macApp: 'LM Studio',
    match: (p) => /\/lm studio\.exe$/.test(p.exe) || /lm studio\.app\/contents\/macos\//.test(p.exe),
    paths: () => W ? [path.join(LA(), 'Programs', 'LM Studio', 'LM Studio.exe')] : [], config: () => path.join(U.HOME, '.lmstudio') },

  { id: 'claude-code', label: 'Claude Code', kind: 'cli', command: 'claude --continue',
    match: (p) => (/\/\.local\/bin\/claude(\.exe)?$/.test(p.exe) || /\/\.claude\/local\/.*claude(\.exe)?$/.test(p.exe) || /@anthropic-ai\/claude-code\/cli\.js/.test(p.cmd)
      || (p.name === 'claude' && /\/bin\/claude/.test(p.cmd))) && !/ -p\b| --print\b/.test(p.cmd),
    config: () => path.join(U.HOME, '.claude') },
  { id: 'codex', label: 'Codex CLI', kind: 'cli', command: 'codex resume --last',
    match: (p) => (/\/codex(\.exe)?$/.test(p.exe) && !/windowsapps|codex\.app/.test(p.exe) || /@openai\/codex\/bin\/codex\.js/.test(p.cmd)) && !/app-server|mcp-server|\bexec\b/.test(p.cmd),
    config: () => path.join(U.HOME, '.codex') },
  { id: 'gemini', label: 'Gemini CLI', kind: 'cli', command: 'gemini',
    match: (p) => /@google\/gemini-cli\/(dist|bundle)\//.test(p.cmd) || /\/gemini(\.exe)?$/.test(p.exe), config: () => path.join(U.HOME, '.gemini') },
  { id: 'copilot', label: 'GitHub Copilot CLI', kind: 'cli', command: 'copilot --continue',
    match: (p) => /@github\/copilot\/(index|npm-loader)\.js/.test(p.cmd) || /\/copilot(\.exe)?$/.test(p.exe), config: () => path.join(U.HOME, '.copilot') },
  { id: 'opencode', label: 'opencode', kind: 'cli', command: 'opencode --continue',
    match: (p) => /\/opencode(\.exe)?$/.test(p.exe) || /opencode-ai\/bin\/opencode/.test(p.cmd), config: () => path.join(U.HOME, '.config', 'opencode') },
  { id: 'qwen', label: 'Qwen Code', kind: 'cli', command: 'qwen', match: (p) => /@qwen-code\/qwen-code/.test(p.cmd), config: () => path.join(U.HOME, '.qwen') },
  { id: 'amp', label: 'Amp', kind: 'cli', command: 'amp', match: (p) => /@sourcegraph\/amp/.test(p.cmd), config: () => path.join(U.HOME, '.config', 'amp') },
  { id: 'droid', label: 'Factory Droid', kind: 'cli', command: 'droid', match: (p) => /\/droid(\.exe)?$/.test(p.exe), config: () => path.join(U.HOME, '.factory') },
  { id: 'crush', label: 'Crush', kind: 'cli', command: 'crush', match: (p) => /\/crush(\.exe)?$/.test(p.exe), config: () => path.join(U.HOME, '.config', 'crush') },
  { id: 'goose', label: 'Goose', kind: 'cli', command: 'goose session --resume', match: (p) => /\/goose(\.exe)?$/.test(p.exe) && !/goosed/.test(p.exe), config: () => path.join(U.HOME, '.config', 'goose') },
];

function prefs() { return U.loadState().harnessPrefs || {}; }

function snapshot() {
  const procs = P.listProcesses().map((p) => Object.assign({}, p, { exe: norm(p.exe), cmd: norm(p.cmd), name: norm(p.name), rawExe: p.exe, rawCmd: p.cmd }));
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  // never touch this server or anything it spawned (e.g. a running "Diagnose with Claude Code")
  const mine = new Set([process.pid]);
  let grew = true;
  while (grew) { grew = false; for (const p of procs) if (!mine.has(p.pid) && mine.has(p.ppid)) { mine.add(p.pid); grew = true; } }
  return { procs: procs.filter((p) => !mine.has(p.pid)), byPid };
}

// Root processes of each harness (a process whose parent is not the same harness).
function instancesOf(h, snap) {
  // background modes (IDE agents over ACP/stdio, daemons, MCP servers) are not sessions to restart
  const background = /\s(--?acp|acp|--stdio|daemon|app-server|mcp(-server)?\s+serve|mcp-server|serve|--print|-p)(\s|$)/;
  const hits = snap.procs.filter((p) => {
    try { return h.match(p) && !(h.kind === 'cli' && background.test(p.cmd)); } catch { return false; }
  });
  const ids = new Set(hits.map((p) => p.pid));
  const roots = hits.filter((p) => !ids.has(p.ppid));
  if (h.kind === 'cli') {
    // a CLI launched through a node shim shows up twice (shim + node); keep the outermost
    return roots.map((p) => ({ pid: p.pid, exe: p.rawExe, cmd: (p.rawCmd || '').slice(0, 300), cwd: P.processCwd(p.pid) }));
  }
  return roots.map((p) => ({ pid: p.pid, exe: p.rawExe, cmd: (p.rawCmd || '').slice(0, 300), children: hits.length - 1 }));
}

function installedPath(h) {
  for (const c of (h.paths ? h.paths() : [])) {
    if (path.isAbsolute(c)) { if (fs.existsSync(c)) return c; }
    else { const w = P.which(c); if (w) return w; }
  }
  if (M && h.macApp && (fs.existsSync(`/Applications/${h.macApp}.app`) || fs.existsSync(path.join(U.HOME, 'Applications', h.macApp + '.app')))) return `/Applications/${h.macApp}.app`;
  if (h.kind === 'cli') { const bin = (h.command || '').split(' ')[0]; return bin ? P.which(bin) : null; }
  return null;
}

function status() {
  const snap = snapshot();
  const pr = prefs();
  const stopped = stoppedRecords();
  const out = [];
  for (const h of REGISTRY) {
    const inst = instancesOf(h, snap);
    const where = installedPath(h);
    const cfg = h.config && h.config();
    const present = inst.length || where || (cfg && fs.existsSync(cfg));
    if (!present) continue;
    const p = pr[h.id] || {};
    out.push({ id: h.id, label: h.label, kind: h.kind, running: inst.length, instances: inst, installed: where ? U.rel(where) : null,
      canLaunch: h.kind === 'cli' ? !!where : !!(where || inst.length || (M && h.macApp)),
      command: p.command || h.command || '', cwd: p.cwd || '', env: p.env || {},
      stopped: stopped[h.id] || null, stoppedCount: stoppedCount(stopped[h.id]) });
  }
  return { os: P.osName(), harnesses: out };
}

function setPrefs({ id, command, cwd, env }) {
  const state = U.loadState();
  state.harnessPrefs = state.harnessPrefs || {};
  const cur = state.harnessPrefs[id] || {};
  if (command !== undefined) cur.command = command;
  if (cwd !== undefined) cur.cwd = cwd;
  if (env !== undefined) cur.env = env;
  state.harnessPrefs[id] = cur;
  U.saveState(state);
  return { ok: true };
}

// ---------- stop / start (restart = stop + start) ----------
// What the app stopped is remembered in state.stoppedHarnesses[id] so "Start" can reopen it:
//   { at: ISO time, gui: { exe, msixAppId } | null, cli: [{ cwd, command }] }
function cwdFor(pr) { return pr.cwd ? pr.cwd.replace(/^~(?=$|[\\/])/, U.HOME) : U.HOME; }

// Pure: the record for the instances that are about to be stopped.
function buildStopRecord(h, inst, { exe, msixAppId, command, defaultCwd, at }) {
  if (h.kind === 'gui') return { at, gui: { exe: exe || null, msixAppId: msixAppId || null }, cli: [] };
  return { at, gui: null, cli: inst.map((i) => ({ cwd: i.cwd || defaultCwd, command })) };
}
// Pure: stopping again before starting adds to what was already recorded.
function mergeStopRecords(old, rec) {
  if (!old) return rec;
  return { at: rec.at, gui: rec.gui || old.gui || null, cli: (old.cli || []).concat(rec.cli || []) };
}
// Pure: turn a record (or none) into what to launch. ctx: { running, exe, command, defaultCwd }.
// No record means "one instance", like Start on a stopped harness. A GUI app that is already
// running is skipped; a CLI always gets its terminals.
function planStart(h, rec, { running = 0, exe = null, command = '', defaultCwd = '' } = {}) {
  const plan = { gui: null, terminals: [], notes: [], skipped: false };
  if (h.kind === 'gui') {
    if (running) { plan.skipped = true; plan.notes.push('already running'); return plan; }
    const g = rec && rec.gui;
    plan.gui = { exe: (g && g.exe) || exe || null, msixAppId: (g && g.msixAppId) || null };
    return plan;
  }
  const items = rec && rec.cli && rec.cli.length ? rec.cli : [{ cwd: defaultCwd, command }];
  plan.terminals = items.map((i) => ({ cwd: i.cwd || defaultCwd, command: i.command || command }));
  return plan;
}

function stoppedRecords() { return U.loadState().stoppedHarnesses || {}; }
function saveStopRecord(id, rec) {
  const state = U.loadState();
  state.stoppedHarnesses = state.stoppedHarnesses || {};
  state.stoppedHarnesses[id] = mergeStopRecords(state.stoppedHarnesses[id], rec);
  U.saveState(state);
}
function clearStopRecord(id) {
  const state = U.loadState();
  if (state.stoppedHarnesses && state.stoppedHarnesses[id]) { delete state.stoppedHarnesses[id]; U.saveState(state); }
}
function stoppedCount(rec) { return !rec ? 0 : rec.gui ? 1 : (rec.cli || []).length; }

// Close the instances (all, or the pids given). Returns { result, record }; the record is saved
// unless persist is false (restart keeps it in memory and starts straight away).
async function stopOne(h, snap, { pids, persist = true } = {}) {
  const pr = prefs()[h.id] || {};
  let inst = instancesOf(h, snap);
  if (pids) inst = inst.filter((i) => pids.includes(i.pid));
  const result = { id: h.id, label: h.label, closed: 0, forced: 0, launched: 0, notes: [] };
  if (!inst.length) { result.notes.push('not running'); return { result, record: null }; }
  const defaultCwd = cwdFor(pr);
  const exe = h.kind === 'gui' ? ((inst.find((i) => i.exe) || {}).exe || installedPath(h)) : null;
  const record = buildStopRecord(h, inst, { exe, msixAppId: exe ? P.msixAppIdFor(exe) : null, command: pr.command || h.command, defaultCwd, at: new Date().toISOString() });
  Object.assign(result, await P.terminate(inst.map((i) => i.pid), { graceMs: h.kind === 'gui' ? 8000 : 4000 }));
  if (h.kind === 'cli' && P.IS_WIN && !pr.cwd) result.notes.push(`Windows does not expose a CLI's working folder, so it reopens in ${U.rel(defaultCwd)}; set a folder under Launch settings.`);
  if (persist) saveStopRecord(h.id, record);
  return { result, record };
}

// Open what the record says (or one instance). running: instances up now. Clears the record on success.
async function startOne(h, snap, { record, running = instancesOf(h, snap).length, keepRecord = false } = {}) {
  const pr = prefs()[h.id] || {};
  const rec = record === undefined ? stoppedRecords()[h.id] : record;
  const env = Object.assign(P.freshEnv(), pr.env || {});
  const result = { id: h.id, label: h.label, closed: 0, forced: 0, launched: 0, notes: [] };
  const plan = planStart(h, rec, { running, exe: h.kind === 'gui' ? installedPath(h) : null, command: pr.command || h.command, defaultCwd: cwdFor(pr) });
  result.notes.push(...plan.notes);
  if (plan.gui) {
    const exe = plan.gui.exe;
    if (!exe && !(M && h.macApp)) throw new Error('could not find ' + h.label + ' to relaunch');
    const msix = plan.gui.msixAppId || (exe ? P.msixAppIdFor(exe) : null);
    const macBundle = M && exe && exe.includes('.app/') ? exe : null;
    P.launchGui({ exe: macBundle || (exe && !exe.endsWith('.app') ? exe : null), macApp: h.macApp, msixAppId: msix }, env);
    result.launched = 1;
  }
  for (const t of plan.terminals) {
    P.openTerminal(t.command, fs.existsSync(t.cwd) ? t.cwd : U.HOME, env, pr.env);
    result.launched++;
  }
  if (!keepRecord && (result.launched || plan.skipped)) clearStopRecord(h.id);
  return result;
}

// Restart (or start) one harness = stop then start. pids: optional subset of instance pids.
async function restartOne(h, snap, { pids, startIfStopped = true } = {}) {
  let inst = instancesOf(h, snap);
  if (pids) inst = inst.filter((i) => pids.includes(i.pid));
  if (!inst.length && !startIfStopped) return { id: h.id, label: h.label, closed: 0, forced: 0, launched: 0, notes: ['not running'] };
  const stopped = inst.length ? await stopOne(h, snap, { pids, persist: false }) : null;
  const result = stopped ? stopped.result : { id: h.id, label: h.label, closed: 0, forced: 0, launched: 0, notes: [] };
  // restart reopens exactly what it just closed (or one instance); it never replays an older stop record
  const started = await startOne(h, snap, { record: stopped ? stopped.record : null, running: 0, keepRecord: true });
  result.launched = started.launched;
  result.notes.push(...started.notes);
  return result;
}

function logRun(op, ids, results) {
  const state = U.loadState();
  U.logOp(state, { op, ids, results: results.map((r) => `${r.id}:${r.closed}+${r.forced}/${r.launched}`) });
  U.saveState(state);
}

// ids: harness ids, or ['*'] for every harness that is running. pids: { [id]: [pid...] }.
async function restart({ ids, pids, startIfStopped }) {
  const snap = snapshot();
  const all = ids && ids.includes('*');
  const targets = REGISTRY.filter((h) => all ? instancesOf(h, snap).length : (ids || []).includes(h.id));
  const res = { results: [], errors: [] };
  for (const h of targets) {
    try { res.results.push(await restartOne(h, snap, { pids: pids && pids[h.id], startIfStopped: all ? false : startIfStopped !== false })); }
    catch (e) { res.errors.push(`${h.label}: ${e.message}`); }
  }
  logRun('restart', ids, res.results);
  return res;
}

// Stop every running instance (or the pids given) and remember what was running.
async function stop({ ids, pids }) {
  const snap = snapshot();
  const all = ids && ids.includes('*');
  const targets = REGISTRY.filter((h) => all ? instancesOf(h, snap).length : (ids || []).includes(h.id));
  const res = { results: [], errors: [] };
  for (const h of targets) {
    try { res.results.push((await stopOne(h, snap, { pids: pids && pids[h.id] })).result); }
    catch (e) { res.errors.push(`${h.label}: ${e.message}`); }
  }
  if (!targets.length) res.message = all ? 'No coding harnesses are running.' : 'Nothing to stop.';
  logRun('stop', ids, res.results);
  return res;
}

// Reopen what the app last stopped. ['*'] = every harness with a stop record (never launches
// harnesses that were not stopped by this app). A named harness with no record starts one instance.
async function start({ ids }) {
  const snap = snapshot();
  const all = ids && ids.includes('*');
  const recs = stoppedRecords();
  const targets = REGISTRY.filter((h) => all ? recs[h.id] : (ids || []).includes(h.id));
  const res = { results: [], errors: [] };
  if (!targets.length) { res.message = all ? 'Nothing to start: this app has not stopped any harness.' : 'Nothing to start.'; return res; }
  for (const h of targets) {
    try { res.results.push(await startOne(h, snap)); }
    catch (e) { res.errors.push(`${h.label}: ${e.message}`); }
  }
  logRun('start', ids, res.results);
  return res;
}

// Map a label used elsewhere in the UI (skills sidebar, MCP config, plugin harness) to a registry id.
function idForLabel(label) {
  const l = String(label || '').toLowerCase();
  if (/claude desktop/.test(l)) return 'claude-desktop';
  if (/^claude code|^claude$/.test(l)) return 'claude-code';
  if (/^codex/.test(l)) return 'codex';
  if (/^gemini/.test(l)) return 'gemini';
  if (/antigravity/.test(l)) return 'antigravity';
  if (/insiders/.test(l)) return 'vscode-insiders';
  if (/^vs ?code|^cline|^roo|^kilo/.test(l)) return 'vscode';
  if (/copilot/.test(l)) return 'copilot';
  if (/chatgpt/.test(l)) return 'chatgpt';
  const h = REGISTRY.find((x) => l.startsWith(x.label.toLowerCase()) || l.startsWith(x.id));
  return h ? h.id : null;
}

module.exports = { REGISTRY, status, restart, stop, start, setPrefs, idForLabel, snapshot, instancesOf,
  buildStopRecord, mergeStopRecords, planStart, stoppedRecords, saveStopRecord, clearStopRecord, stoppedCount, stopOne, startOne, restartOne };
