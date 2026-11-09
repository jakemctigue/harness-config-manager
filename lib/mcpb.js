'use strict';
// Native .mcpb (MCP Bundle, formerly .dxt) support with no dependencies:
//   inspect   read manifest.json and the file list straight out of the zip
//   install   extract to ~/.skill-manager/mcpb/<name>/ and write an MCP server entry, built from
//             manifest.server.mcp_config, into any harness config (Claude Code, Codex TOML, Cursor...)
//   desktop   hand the bundle to Claude Desktop, which owns its own extension installer
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const U = require('./util');
const P = require('./platform');
const mcp = require('./mcp');

// ---------- zip ----------
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive (.mcpb files are zip archives)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff) throw new Error('ZIP64 bundles are not supported');
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28), elen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nlen).toString('utf8');
    entries.push({ name, method, csize, usize, local, dir: name.endsWith('/') });
    off += 46 + nlen + elen + clen;
  }
  const read = (e) => {
    if (buf.readUInt32LE(e.local) !== 0x04034b50) throw new Error('corrupt zip entry ' + e.name);
    const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    const data = buf.slice(start, start + e.csize);
    if (e.method === 0) return data;
    if (e.method === 8) return zlib.inflateRawSync(data);
    throw new Error(`unsupported compression (${e.method}) for ${e.name}`);
  };
  return { entries, read };
}

function safeEntryPath(root, name) {
  const p = path.resolve(root, name);
  const r = path.relative(root, p);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) throw new Error('unsafe path in bundle: ' + name);
  return p;
}

// ---------- manifest ----------
function inspect(buf) {
  const z = readZip(buf);
  const me = z.entries.find((e) => e.name === 'manifest.json');
  if (!me) throw new Error('bundle has no manifest.json at its root');
  const manifest = JSON.parse(z.read(me).toString('utf8').replace(/^﻿/, ''));
  if (!manifest.name || !manifest.server) throw new Error('manifest.json is missing "name" or "server"');
  const files = z.entries.filter((e) => !e.dir);
  const compat = manifest.compatibility && manifest.compatibility.platforms;
  return {
    manifest,
    name: manifest.name,
    displayName: manifest.display_name || manifest.name,
    version: manifest.version || '',
    description: manifest.description || '',
    author: manifest.author && manifest.author.name,
    serverType: manifest.server.type,
    userConfig: manifest.user_config || {},
    tools: (manifest.tools || []).map((t) => t.name),
    platforms: compat || null,
    supportsThisOs: !compat || compat.includes(process.platform),
    fileCount: files.length,
    unpackedBytes: files.reduce((n, e) => n + e.usize, 0),
    serverName: suggestedName(manifest.name),
  };
}

function suggestedName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'mcpb-server';
}

function knownDir(name) {
  if (name === 'HOME') return U.HOME;
  const map = { DESKTOP: 'Desktop', DOCUMENTS: 'Documents', DOWNLOADS: 'Downloads' };
  return path.join(U.HOME, map[name]);
}

// A value that starts with a path placeholder becomes a native path (\ on Windows).
function fixSep(s) {
  return /^\$\{(__dirname|HOME|DESKTOP|DOCUMENTS|DOWNLOADS)\}[\\/][^\s]*$/.test(s) && !/\$\{user_config/.test(s) ? s.replace(/[\\/]/g, path.sep) : s;
}

// Turn manifest.server into a concrete {command,args,env} for this OS.
function buildServerConfig(manifest, dir, userValues = {}) {
  const server = manifest.server || {};
  let cfg = server.mcp_config ? JSON.parse(JSON.stringify(server.mcp_config)) : null;
  if (!cfg) {
    const entry = server.entry_point || '';
    if (server.type === 'node') cfg = { command: 'node', args: ['${__dirname}/' + entry] };
    else if (server.type === 'python') cfg = { command: P.IS_WIN ? 'python' : 'python3', args: ['${__dirname}/' + entry] };
    else cfg = { command: '${__dirname}/' + entry, args: [] };
  }
  const ov = cfg.platform_overrides && cfg.platform_overrides[process.platform];
  if (ov) cfg = Object.assign({}, cfg, ov);
  delete cfg.platform_overrides;

  const uc = manifest.user_config || {};
  const values = {};
  for (const [k, spec] of Object.entries(uc)) {
    let v = userValues[k];
    if (v === undefined || v === '') v = spec.default;
    if (typeof v === 'string') v = fixSep(v).replace(/\$\{(HOME|DESKTOP|DOCUMENTS|DOWNLOADS)\}/g, (_, n) => knownDir(n));
    if (Array.isArray(v)) v = v.map((x) => typeof x === 'string' ? fixSep(x).replace(/\$\{(HOME|DESKTOP|DOCUMENTS|DOWNLOADS)\}/g, (_, n) => knownDir(n)) : x);
    if ((v === undefined || v === '') && spec.required) throw new Error(`"${spec.title || k}" is required`);
    values[k] = v;
  }
  const sub = (s) => fixSep(String(s))
    .replace(/\$\{__dirname\}/g, dir)
    .replace(/\$\{(HOME|DESKTOP|DOCUMENTS|DOWNLOADS)\}/g, (_, n) => knownDir(n))
    .replace(/\$\{(pathSeparator|\/)\}/g, path.sep)
    .replace(/\$\{user_config\.([A-Za-z0-9_]+)\}/g, (_, k) => {
      const v = values[k];
      return v === undefined || v === null ? '' : Array.isArray(v) ? v.join(' ') : String(v);
    });
  const args = [];
  for (const a of cfg.args || []) {
    const m = typeof a === 'string' && a.match(/^\$\{user_config\.([A-Za-z0-9_]+)\}$/);
    if (m && Array.isArray(values[m[1]])) args.push(...values[m[1]].map(String));
    else args.push(sub(a));
  }
  const out = { command: sub(cfg.command || ''), args };
  if (cfg.env) {
    out.env = {};
    for (const [k, v] of Object.entries(cfg.env)) {
      const s = sub(v);
      if (s !== '') out.env[k] = s;
    }
    if (!Object.keys(out.env).length) delete out.env;
  }
  return out;
}

function extract(buf, dest) {
  const z = readZip(buf);
  U.ensureDir(dest);
  for (const e of z.entries) {
    const p = safeEntryPath(dest, e.name);
    if (e.dir) { U.ensureDir(p); continue; }
    U.ensureDir(path.dirname(p));
    fs.writeFileSync(p, z.read(e));
  }
  if (!P.IS_WIN) {
    // zip loses the executable bit for binary servers; restore it for the entry point
    const man = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'));
    if (man.server && man.server.type === 'binary' && man.server.entry_point) {
      try { fs.chmodSync(path.join(dest, man.server.entry_point), 0o755); } catch {}
    }
  }
}

// targets: [{ file, keyPath }] from mcp.installTargets()
function install({ buf, targets, userValues, serverName }) {
  const info = inspect(buf);
  const name = suggestedName(serverName || info.serverName);
  const base = path.join(U.DATA, 'mcpb', name);
  const dir = info.version ? path.join(base, info.version) : base;
  if (fs.existsSync(dir)) {
    const old = path.join(U.DATA, 'trash', U.stamp(), 'mcpb-' + name);
    U.ensureDir(path.dirname(old));
    fs.renameSync(dir, old);
  }
  extract(buf, dir);
  const value = buildServerConfig(info.manifest, dir, userValues);
  const res = { changed: 0, errors: [], dir: U.rel(dir), server: value };
  const all = mcp.installTargets();
  for (const t of targets || []) {
    const tgt = all.find((x) => x.id === t);
    if (!tgt) { res.errors.push(`${t}: unknown target`); continue; }
    try { mcp.addServer({ file: tgt.file, keyPath: tgt.keyPath, name, value }); res.changed++; }
    catch (e) { res.errors.push(`${tgt.harness}: ${e.message}`); }
  }
  const state = U.loadState();
  state.mcpb = (state.mcpb || []).filter((x) => x.name !== name).concat([{ name, version: info.version, dir, at: new Date().toISOString() }]);
  U.logOp(state, { op: 'mcpb-install', name, targets, changed: res.changed });
  U.saveState(state);
  return res;
}

// Let Claude Desktop install it through its own dialog (it registers .mcpb/.dxt on install).
function openInClaudeDesktop({ buf, fileName }) {
  const info = inspect(buf);
  const dir = U.ensureDir(path.join(U.DATA, 'mcpb-files'));
  const file = path.join(dir, suggestedName(path.basename(fileName || info.name, path.extname(fileName || ''))) + '.mcpb');
  fs.writeFileSync(file, buf);
  P.openWithDefault(file);
  return { ok: true, file: U.rel(file) };
}

module.exports = { readZip, inspect, buildServerConfig, install, openInClaudeDesktop, extract, suggestedName };
