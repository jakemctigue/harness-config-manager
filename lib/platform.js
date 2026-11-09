'use strict';
// OS-specific plumbing: app-data folders, reveal-in-file-manager, opening the app window,
// process listing and killing, a fresh environment block, and launching terminals.
// Everything here works on Windows, macOS and Linux with only Node built-ins.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const U = require('./util');

const OS = process.platform; // 'win32' | 'darwin' | 'linux'
const IS_WIN = OS === 'win32';
const IS_MAC = OS === 'darwin';

// Per-user application data folder ("Roaming" on Windows).
function appData() {
  if (IS_WIN) return process.env.SKM_HOME ? path.join(U.HOME, 'AppData', 'Roaming') : (process.env.APPDATA || path.join(U.HOME, 'AppData', 'Roaming'));
  if (IS_MAC) return path.join(U.HOME, 'Library', 'Application Support');
  return process.env.SKM_HOME ? path.join(U.HOME, '.config') : (process.env.XDG_CONFIG_HOME || path.join(U.HOME, '.config'));
}

function localAppData() {
  if (IS_WIN) return process.env.SKM_HOME ? path.join(U.HOME, 'AppData', 'Local') : (process.env.LOCALAPPDATA || path.join(U.HOME, 'AppData', 'Local'));
  return appData();
}

// Find an executable on PATH (honours PATHEXT on Windows).
function which(cmd, env = process.env) {
  const exts = IS_WIN ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase()) : [''];
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const e of [''].concat(exts)) {
      const p = path.join(d, cmd + e);
      try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
  }
  return null;
}

function detach(cmd, args, opts = {}) {
  const child = spawn(cmd, args, Object.assign({ detached: true, stdio: 'ignore', windowsHide: false }, opts));
  child.on('error', () => {});
  child.unref();
  return child;
}

function reveal(abs) {
  const isDir = (() => { try { return fs.statSync(abs).isDirectory(); } catch { return false; } })();
  if (IS_WIN) detach('explorer.exe', isDir ? [abs] : ['/select,', abs]);
  else if (IS_MAC) detach('open', isDir ? [abs] : ['-R', abs]);
  else detach('xdg-open', [isDir ? abs : path.dirname(abs)]);
}

// Open a file with its default handler (e.g. a .mcpb goes to Claude Desktop).
function openWithDefault(abs) {
  if (IS_WIN) detach('cmd.exe', ['/c', 'start', '', abs], { windowsHide: true });
  else if (IS_MAC) detach('open', [abs]);
  else detach('xdg-open', [abs]);
}

// Open the UI in a chromeless app window when a Chromium browser is available.
function openAppWindow(url) {
  const appArgs = [`--app=${url}`, '--window-size=1440,920'];
  if (IS_WIN) {
    const pf = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], localAppData()].filter(Boolean);
    const cands = [];
    for (const base of pf) {
      cands.push(path.join(base, 'Microsoft/Edge/Application/msedge.exe'), path.join(base, 'Google/Chrome/Application/chrome.exe'),
        path.join(base, 'BraveSoftware/Brave-Browser/Application/brave.exe'));
    }
    const exe = cands.find((p) => fs.existsSync(p));
    if (exe) return detach(exe, appArgs);
    return detach('cmd.exe', ['/c', 'start', '', url], { windowsHide: true });
  }
  if (IS_MAC) {
    const apps = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium', 'Arc'];
    const app = apps.find((a) => fs.existsSync(`/Applications/${a}.app`) || fs.existsSync(path.join(U.HOME, 'Applications', `${a}.app`)));
    if (app) return detach('open', ['-na', app, '--args', ...appArgs]);
    return detach('open', [url]);
  }
  for (const b of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser']) {
    const p = which(b);
    if (p) return detach(p, appArgs);
  }
  return detach('xdg-open', [url]);
}

// ---------- processes ----------
// Returns [{ pid, ppid, name, exe, cmd }].
function listProcesses() {
  try {
    if (IS_WIN) {
      const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 20000 });
      const arr = JSON.parse(out || '[]');
      return (Array.isArray(arr) ? arr : [arr]).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name || '',
        exe: p.ExecutablePath || '', cmd: p.CommandLine || '' }));
    }
    const out = execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,comm=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15000 });
    const rows = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name: path.basename(m[3]), exe: m[3].startsWith('/') ? m[3] : '', cmd: m[4] });
    }
    return rows;
  } catch { return []; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Working directory of a process where the OS exposes it (Linux /proc, macOS lsof).
function processCwd(pid) {
  try {
    if (OS === 'linux') return fs.readlinkSync(`/proc/${pid}/cwd`);
    if (IS_MAC) {
      const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 5000 });
      const m = out.match(/^n(.+)$/m);
      return m ? m[1] : null;
    }
  } catch {}
  return null;
}

// Ask processes to close, wait, then force the stragglers. Returns { closed, forced }.
async function terminate(pids, { graceMs = 6000 } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  pids = pids.filter((p) => p && p !== process.pid);
  for (const pid of pids) {
    try {
      if (IS_WIN) execFileSync('taskkill.exe', ['/PID', String(pid), '/T'], { stdio: 'ignore', windowsHide: true });
      else process.kill(pid, 'SIGTERM');
    } catch {}
  }
  const until = Date.now() + graceMs;
  while (Date.now() < until && pids.some(alive)) await sleep(250);
  const left = pids.filter(alive);
  for (const pid of left) {
    try {
      if (IS_WIN) execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else process.kill(pid, 'SIGKILL');
    } catch {}
  }
  await sleep(400);
  return { closed: pids.length - left.length, forced: left.length };
}

// ---------- environment ----------
// The server's own process.env is frozen at launch. A restarted harness should see variables the
// user set since then, so rebuild them from the source of truth for each OS.
function parseRegQuery(out) {
  const vars = {};
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s{4}(\S.*?)\s{4}(REG_SZ|REG_EXPAND_SZ)\s{4}(.*)$/) || line.match(/^\s{4}(\S.*?)\s{4}(REG_SZ|REG_EXPAND_SZ)\s*$/);
    if (m) vars[m[1]] = { value: m[3] || '', expand: m[2] === 'REG_EXPAND_SZ' };
  }
  return vars;
}

function expandWin(v, env) {
  return v.replace(/%([^%]+)%/g, (all, k) => {
    const hit = Object.keys(env).find((x) => x.toLowerCase() === k.toLowerCase());
    return hit ? env[hit] : all;
  });
}

let envCache = null;
function freshEnv() {
  if (envCache && Date.now() - envCache.at < 3000) return Object.assign({}, envCache.env);
  const env = Object.assign({}, process.env);
  try {
    if (IS_WIN) {
      const q = (key) => { try { return parseRegQuery(execFileSync('reg.exe', ['query', key], { encoding: 'utf8', windowsHide: true, timeout: 8000 })); } catch { return {}; } };
      const machine = q('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment');
      const user = q('HKCU\\Environment');
      const setKey = (k, v) => {
        const hit = Object.keys(env).find((x) => x.toLowerCase() === k.toLowerCase());
        if (hit && hit !== k) delete env[hit];
        env[k] = v;
      };
      for (const [k, r] of Object.entries(machine)) setKey(k, r.expand ? expandWin(r.value, env) : r.value);
      for (const [k, r] of Object.entries(user)) {
        if (k.toLowerCase() === 'path') continue;
        setKey(k, r.expand ? expandWin(r.value, env) : r.value);
      }
      const mp = machine.Path || machine.PATH, up = user.Path || user.PATH;
      if (mp || up) {
        const parts = [mp && (mp.expand ? expandWin(mp.value, env) : mp.value), up && (up.expand ? expandWin(up.value, env) : up.value)].filter(Boolean);
        setKey('Path', parts.join(';'));
      }
    } else {
      const shell = process.env.SHELL || (IS_MAC ? '/bin/zsh' : '/bin/bash');
      const out = execFileSync(shell, ['-l', '-i', '-c', 'env -0'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
      for (const kv of out.split('\0')) {
        const i = kv.indexOf('=');
        if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
      }
    }
  } catch {}
  for (const k of Object.keys(env)) if (k.startsWith('SKM_')) delete env[k];
  envCache = { at: Date.now(), env };
  return Object.assign({}, env);
}

// ---------- launching ----------
function shQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
function cmdQuote(s) { return /[\s&|<>^"]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s); }

// Write a launcher script that sets the extra variables and runs the command in cwd. A script
// (instead of passing env to the terminal) works even when the terminal process already exists.
function writeLauncher(command, cwd, extraEnv) {
  const dir = U.ensureDir(path.join(U.DATA, 'launchers'));
  const id = U.stamp() + '-' + Math.random().toString(36).slice(2, 7);
  if (IS_WIN) {
    const lines = ['@echo off'];
    for (const [k, v] of Object.entries(extraEnv || {})) lines.push(`set "${k}=${String(v).replace(/"/g, '')}"`);
    lines.push(`cd /d ${cmdQuote(cwd)}`, command, '');
    const p = path.join(dir, id + '.cmd');
    fs.writeFileSync(p, lines.join('\r\n'));
    return p;
  }
  const lines = ['#!/bin/sh'];
  for (const [k, v] of Object.entries(extraEnv || {})) lines.push(`export ${k}=${shQuote(v)}`);
  lines.push(`cd ${shQuote(cwd)} || exit 1`, command, `exec "\${SHELL:-/bin/sh}" -l`, '');
  const p = path.join(dir, id + (IS_MAC ? '.command' : '.sh'));
  fs.writeFileSync(p, lines.join('\n'), { mode: 0o755 });
  return p;
}

// Open a new terminal window running `command` in `cwd` with `env` applied.
function openTerminal(command, cwd, env, extraEnv) {
  const script = writeLauncher(command, cwd, extraEnv);
  if (IS_WIN) {
    const wt = which('wt', env);
    if (wt) return detach(wt, ['-w', 'new', '-d', cwd, 'cmd.exe', '/k', script], { env });
    return detach('cmd.exe', ['/c', 'start', '""', 'cmd.exe', '/k', script], { env, windowsHide: true });
  }
  if (IS_MAC) return detach('open', ['-a', 'Terminal', script], { env });
  const terms = [['x-terminal-emulator', ['-e']], ['gnome-terminal', ['--']], ['konsole', ['-e']], ['xfce4-terminal', ['-x']],
    ['kitty', []], ['alacritty', ['-e']], ['wezterm', ['start', '--']], ['xterm', ['-e']]];
  for (const [t, pre] of terms) {
    const p = which(t, env);
    if (p) return detach(p, [...pre, script], { env, cwd });
  }
  throw new Error('no terminal emulator found; run this yourself: ' + command);
}

// Launch a GUI app. `exe` is a path seen on the running process, or a candidate install path.
function launchGui({ exe, args = [], macApp, msixAppId }, env) {
  if (msixAppId) return detach('explorer.exe', [`shell:AppsFolder\\${msixAppId}`], { env });
  if (exe && fs.existsSync(exe)) return detach(exe, args, { env, cwd: path.dirname(exe) });
  if (IS_MAC && macApp) return detach('open', ['-a', macApp, ...(args.length ? ['--args', ...args] : [])], { env });
  if (exe) {
    const p = which(exe, env);
    if (p) return detach(p, args, { env });
  }
  throw new Error('could not find the app to relaunch');
}

// MSIX apps (Program Files\WindowsApps) cannot be started by exe path; resolve their AppUserModelID.
function msixAppIdFor(exe) {
  if (!IS_WIN || !/\\WindowsApps\\/i.test(exe || '')) return null;
  const m = exe.match(/\\WindowsApps\\([^\\_]+)_[^\\]*__([a-z0-9]+)\\/i);
  if (!m) return null;
  const family = `${m[1]}_${m[2]}`;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-StartApps | Where-Object { $_.AppID -like '${family}!*' } | Select-Object -First 1 -ExpandProperty AppID`], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return out.trim() || `${family}!App`;
  } catch { return `${family}!App`; }
}

module.exports = {
  OS, IS_WIN, IS_MAC, appData, localAppData, which, reveal, openWithDefault, openAppWindow,
  listProcesses, processCwd, terminate, alive, freshEnv, parseRegQuery, openTerminal, launchGui, msixAppIdFor, writeLauncher,
  osName: () => ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[OS] || OS) + ' ' + os.release(),
};
