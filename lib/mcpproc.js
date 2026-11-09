'use strict';
// Running MCP server processes: find them, see which harness owns them, and restart them.
//   stdio servers  are children of a harness. Restart = end the server's process tree; most
//                  harnesses start it again on the next tool call or reconnect, and if one does
//                  not, the result says so and the UI offers to restart that harness.
//   local HTTP     servers (url on localhost) are found by the port they listen on. Restart =
//                  end the process and, unless a supervisor brings it back, start the same
//                  command line again with a fresh environment.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const U = require('./util');
const P = require('./platform');
const mcp = require('./mcp');
const harness = require('./harness');

const GENERIC = /^(npx(\.cmd)?|node(\.exe)?|uvx|uv|python3?(\.exe)?|py|bunx|bun|deno|pnpm|dlx|yarn|cmd(\.exe)?|\/c|run|exec|tsx|ts-node|java|-jar)$/i;
const norm = (s) => String(s || '').replace(/\\/g, '/').replace(/["']/g, '').toLowerCase();

// Distinctive strings a server's process command line must contain.
function keysFor(summary) {
  const toks = String(summary || '').split(/\s+/).filter(Boolean);
  const keys = [];
  for (let t of toks) {
    if (GENERIC.test(t) || t.startsWith('-') || /^https?:/.test(t) || t.length < 3) continue;
    t = norm(t);
    if (/^@[^/]+\/[^@]+@/.test(t) || /^[^@/][^@]*@[\w.^~-]+$/.test(t)) t = t.replace(/@[^@/]*$/, ''); // drop @version
    if (/^(sk-|ghp_|xox)/.test(t) || /=/.test(t)) continue; // secrets and KEY=value pairs
    keys.push(t);
  }
  // the most specific first: paths and scoped packages, then the longest
  keys.sort((a, b) => (/[/@]/.test(b) - /[/@]/.test(a)) || b.length - a.length);
  return keys.slice(0, 2);
}

function localPort(url) {
  try {
    const u = new URL(url);
    if (!['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'].includes(u.hostname)) return null;
    return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch { return null; }
}

function listeners(ports) {
  const out = new Map();
  if (!ports.length) return out;
  try {
    if (P.IS_WIN) {
      const ps = `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { @(${ports.join(',')}) -contains $_.LocalPort } | Select-Object LocalPort,OwningProcess | ConvertTo-Json -Compress`;
      const txt = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      const arr = txt.trim() ? [].concat(JSON.parse(txt)) : [];
      for (const r of arr) out.set(r.LocalPort, r.OwningProcess);
    } else {
      for (const port of ports) {
        try {
          const pid = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0];
          if (pid) out.set(port, Number(pid));
        } catch {}
      }
    }
  } catch {}
  return out;
}

function ownerOf(pid, snap) {
  let p = snap.byPid.get(pid);
  for (let hops = 0; p && hops < 30; hops++) {
    p = snap.byPid.get(p.ppid);
    if (!p) break;
    const h = harness.REGISTRY.find((r) => { try { return r.match(p); } catch { return false; } });
    if (h) return { id: h.id, label: h.label, pid: p.pid };
  }
  return null;
}

// One snapshot of every configured server's running processes.
function find(snap = harness.snapshot()) {
  const servers = mcp.scan().servers;
  const ports = new Map();
  for (const s of servers) for (const i of s.installs) {
    const port = /^https?:/.test(i.summary || '') && localPort(i.summary);
    if (port) ports.set(port, s.name);
  }
  const listen = listeners([...ports.keys()]);
  const all = [...snap.byPid.values()];
  const result = {};
  for (const s of servers) {
    const procs = [];
    const seen = new Set();
    for (const i of s.installs) {
      if (!i.enabled) continue;
      if (/^https?:/.test(i.summary || '')) {
        const port = localPort(i.summary);
        const pid = port && listen.get(port);
        const p = pid && snap.byPid.get(pid);
        if (p && !seen.has(pid)) {
          seen.add(pid);
          // a port served from inside a harness (e.g. a VS Code extension) is restarted with that harness
          const self = harness.REGISTRY.find((r) => { try { return r.match(p); } catch { return false; } });
          const owner = self ? { id: self.id, label: self.label, pid } : ownerOf(pid, snap);
          procs.push({ pid, kind: 'http', port, owner, insideHarness: !!self || !!(owner && harness.REGISTRY.find((r) => r.id === owner.id).kind === 'gui'),
            cmd: (p.rawCmd || p.rawExe || '').slice(0, 400), harness: i.harness });
        }
        continue;
      }
      const keys = keysFor(i.summary);
      if (!keys.length) continue;
      const hits = all.filter((p) => keys.every((k) => norm(p.rawCmd).includes(k)) && !/powershell|wmic|ps -ax/.test(p.cmd));
      const ids = new Set(hits.map((p) => p.pid));
      // keep the root of each server tree (cmd -> npx -> node -> server), even with unmatched hops between
      const hasMatchedAncestor = (p) => {
        let q = snap.byPid.get(p.ppid);
        for (let hops = 0; q && hops < 6; hops++) { if (ids.has(q.pid)) return true; q = snap.byPid.get(q.ppid); }
        return false;
      };
      for (const p of hits) {
        if (seen.has(p.pid) || hasMatchedAncestor(p)) continue;
        seen.add(p.pid);
        procs.push({ pid: p.pid, kind: 'stdio', owner: ownerOf(p.pid, snap), cmd: (p.rawCmd || '').slice(0, 400), harness: i.harness });
      }
    }
    if (procs.length) result[s.name] = procs;
  }
  return result;
}

function list() {
  return { servers: find() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// names: server names. pids: optional { [name]: [pid] } to restart only some instances.
async function restart({ names, pids }) {
  const before = find();
  const res = { results: [], errors: [] };
  const relaunch = [];
  const ended = [];
  for (const name of names || []) {
    const procs = (before[name] || []).filter((p) => !pids || !pids[name] || pids[name].includes(p.pid));
    if (!procs.length) { res.errors.push(`${name}: not running`); continue; }
    for (const p of procs) {
      if (p.insideHarness) { res.errors.push(`${name}: served from inside ${p.owner.label} (PID ${p.pid}); restart ${p.owner.label} instead`); continue; }
      if (p.kind === 'http') {
        const cwd = P.processCwd(p.pid);
        relaunch.push({ name, port: p.port, cmd: p.cmd, cwd });
      }
      ended.push({ name, pid: p.pid, kind: p.kind, owner: p.owner, port: p.port });
    }
  }
  if (!ended.length) return res;
  await P.terminate(ended.map((e) => e.pid), { graceMs: 3000 });
  await sleep(3500);
  let after = find();
  // local HTTP servers that no supervisor brought back: start the same command line again
  for (const r of relaunch) {
    if ((after[r.name] || []).some((p) => p.kind === 'http')) continue;
    if (!r.cmd) { res.errors.push(`${r.name}: could not read its command line to start it again`); continue; }
    try {
      const child = spawn(r.cmd, { shell: true, detached: true, stdio: 'ignore', windowsHide: true, env: P.freshEnv(), cwd: r.cwd && fs.existsSync(r.cwd) ? r.cwd : U.HOME });
      child.on('error', () => {});
      child.unref();
      r.relaunched = true;
    } catch (e) { res.errors.push(`${r.name}: ${e.message}`); }
  }
  if (relaunch.some((r) => r.relaunched)) { await sleep(3000); after = find(); }
  for (const name of [...new Set(ended.map((e) => e.name))]) {
    const mine = ended.filter((e) => e.name === name);
    const now = (after[name] || []).filter((p) => !mine.some((e) => e.pid === p.pid));
    const owners = [...new Map(mine.filter((e) => e.owner).map((e) => [e.owner.id, e.owner])).values()];
    const back = now.length > 0;
    const r = relaunch.find((x) => x.name === name);
    res.results.push({ name, stopped: mine.length, running: now.length, owners,
      note: back ? (r && r.relaunched ? 'started again by this app' : 'running again')
        : !owners.length && mine.every((e) => e.kind === 'stdio') ? 'orphaned process ended (no harness was using it)'
        : owners.length ? `stopped; ${owners.map((o) => o.label).join(', ')} will start it again on its next use, or restart ${owners.length > 1 ? 'them' : 'it'} to reconnect now`
          : 'stopped' });
  }
  const state = U.loadState();
  U.logOp(state, { op: 'mcp-restart', names, results: res.results.map((x) => `${x.name}:${x.stopped}->${x.running}`) });
  U.saveState(state);
  return res;
}

module.exports = { list, find, restart, keysFor, localPort };
