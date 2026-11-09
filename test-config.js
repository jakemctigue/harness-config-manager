'use strict';
// Sandbox test for plugins/extensions, .mcpb bundles, config files + checks, env vars, and the
// harness registry. Never touches the real home. Run: node test-config.js (test.js runs it too).
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-test2-'));
process.env.SKM_HOME = HOME;
const P = require('./lib/platform');
const mcp = require('./lib/mcp');
const plugins = require('./lib/plugins');
const mcpb = require('./lib/mcpb');
const files = require('./lib/files');
const harness = require('./lib/harness');

const w = (p, t) => { fs.mkdirSync(path.dirname(path.join(HOME, p)), { recursive: true }); fs.writeFileSync(path.join(HOME, p), t); };
const has = (p) => fs.existsSync(path.join(HOME, p));
const readJ = (p) => JSON.parse(fs.readFileSync(path.join(HOME, p), 'utf8'));
let r;

w('.agents/skills/alpha/SKILL.md', '---\nname: alpha\ndescription: The alpha skill\n---\n# alpha\n');
w('.claude.json', JSON.stringify({ mcpServers: { a: { command: 'npx', args: ['a'] } } }, null, 2));
w('.codex/config.toml', 'model = "x"\n\n[mcp_servers.one]\ncommand = "npx"\n\n[plugins."cp@mk"]\nenabled = true\n');

// ---------- plugins & extensions ----------
w('.claude/settings.json', JSON.stringify({ env: { FOO: 'bar', API_KEY: 'sk-secret-123456' }, enabledPlugins: { 'p1@m': true, 'p2@m': false } }, null, 2));
w('.gemini/extensions/gx/gemini-extension.json', JSON.stringify({ name: 'gx', version: '1.0.0' }));
const cdExt = path.relative(HOME, path.join(P.appData(), 'Claude'));
w(`${cdExt}/Claude Extensions/ext.one/manifest.json`, JSON.stringify({ name: 'one', display_name: 'One', version: '2.0.0', server: { type: 'node' } }));
let pl = plugins.scan();
const pid = (id) => pl.items.find((x) => x.id === id);
assert(pid('claude:p1@m').enabled && !pid('claude:p2@m').enabled && pid('codex:cp@mk').enabled && pid('gemini:gx').enabled && pid('desktop:ext.one').enabled);
const ids = ['claude:p1@m', 'codex:cp@mk', 'gemini:gx', 'desktop:ext.one'];
r = plugins.setEnabled({ ids, enabled: false });
assert.strictEqual(r.changed, 4, r.errors.join());
pl = plugins.scan();
assert(!pid('claude:p1@m').enabled && !pid('codex:cp@mk').enabled && !pid('gemini:gx').enabled && !pid('desktop:ext.one').enabled);
assert(!has('.gemini/extensions/gx') && has('.skill-manager/disabled/gemini-extensions/gx/gemini-extension.json'));
assert(fs.readFileSync(path.join(HOME, '.codex/config.toml'), 'utf8').includes('[plugins."cp@mk"]\nenabled = false'));
r = plugins.setEnabled({ ids, enabled: true });
assert.strictEqual(r.changed, 4, r.errors.join());
assert.strictEqual(readJ('.claude/settings.json').enabledPlugins['p1@m'], true);
assert.strictEqual(readJ('.claude/settings.json').env.FOO, 'bar', 'other settings kept');

// ---------- .mcpb ----------
function makeZip(entries) { // minimal deflate zip writer, test only
  const parts = [], central = [];
  let off = 0, count = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text), comp = zlib.deflateRawSync(data), nb = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nb, comp); central.push(ch, nb); off += 30 + nb.length + comp.length; count++;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
const bundle = makeZip({
  'manifest.json': JSON.stringify({ manifest_version: '0.2', name: 'Demo Server', version: '1.2.3', description: 'demo', author: { name: 'me' },
    server: { type: 'node', entry_point: 'server/index.js', mcp_config: { command: 'node', args: ['${__dirname}/server/index.js', '${user_config.dirs}'],
      env: { TOKEN: '${user_config.token}', EMPTY: '${user_config.unset}' }, platform_overrides: { [process.platform]: { env: { TOKEN: '${user_config.token}', OS: 'yes' } } } } },
    user_config: { token: { type: 'string', title: 'Token', sensitive: true, required: true }, dirs: { type: 'directory', multiple: true, default: ['${HOME}/a'] }, unset: { type: 'string' } } }),
  'server/index.js': 'console.log(1)',
});
const info = mcpb.inspect(bundle);
assert.strictEqual(info.serverName, 'demo-server');
assert.strictEqual(info.fileCount, 2);
assert.throws(() => mcpb.install({ buf: bundle, targets: [], userValues: {} }), /Token/);
const tgts = mcp.installTargets();
const codexT = tgts.find((t) => t.harness === 'Codex');
const claudeT = tgts.find((t) => t.harness === 'Claude Code' && t.rel === '~/.claude.json');
assert(codexT && claudeT, 'install targets');
r = mcpb.install({ buf: bundle, targets: [claudeT.id, codexT.id], userValues: { token: 'abc' } });
assert.strictEqual(r.changed, 2, r.errors.join());
const inst = readJ('.claude.json').mcpServers['demo-server'];
assert(inst.args[0].startsWith(path.join(HOME, '.skill-manager', 'mcpb', 'demo-server', '1.2.3')) && inst.args[0].endsWith(path.join('server', 'index.js')), inst.args[0]);
assert.strictEqual(inst.args[1], path.join(HOME, 'a'));
assert.deepStrictEqual(inst.env, { TOKEN: 'abc', OS: 'yes' });
assert(has('.skill-manager/mcpb/demo-server/1.2.3/server/index.js'));
assert(fs.readFileSync(path.join(HOME, '.codex/config.toml'), 'utf8').includes('[mcp_servers.demo-server]'));
assert.strictEqual(mcp.scan().servers.find((s) => s.name === 'demo-server').installs.length, 2);
assert.throws(() => mcpb.inspect(Buffer.from('not a zip at all, definitely not')), /zip/);
const evil = makeZip({ 'manifest.json': JSON.stringify({ name: 'x', server: { type: 'node' } }), '../escape.txt': 'x' });
assert.throws(() => mcpb.install({ buf: evil, targets: [] }), /unsafe/);
assert(!fs.existsSync(path.join(HOME, '.skill-manager', 'mcpb', 'escape.txt')));

// ---------- config files and checks ----------
w('.claude/CLAUDE.md', '# rules\nSee @./missing.md\n');
w('.gemini/.env', 'GEMINI_API_KEY=abc123\nDUP=1\nDUP=2\nBAD LINE\n');
w('.claude/settings.local.json', '{ "permissions": { "allow": ["Bash(ls:*)"], "deny": ["Bash(ls:*)"] }, "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "/no/such/hook.sh" } ] } ] } }');
const found = files.discover();
const fr = (rel) => found.find((f) => f.rel === rel);
assert(fr('~/.claude.json') && fr('~/.claude/CLAUDE.md') && fr('~/.gemini/.env') && fr('~/.claude/settings.json'), 'discovers configs');
assert.strictEqual(fr('~/.gemini/.env').kind, 'env');
assert.strictEqual(fr('~/.claude/CLAUDE.md').kind, 'instructions');
let iss = files.checkFile({ path: '~/.claude/CLAUDE.md' }).issues;
assert(iss.some((i) => /missing\.md/.test(i.msg)), 'flags missing @import');
iss = files.checkFile({ path: '~/.gemini/.env' }).issues;
assert(iss.some((i) => /DUP/.test(i.msg)) && iss.some((i) => /line 4/.test(i.msg)));
iss = files.checkFile({ path: '~/.claude/settings.local.json' }).issues;
assert(iss.some((i) => /both permissions/.test(i.msg)) && iss.some((i) => /hook\.sh/.test(i.msg)), JSON.stringify(iss));
iss = files.checkFile({ path: '~/.claude.json', text: '{ "a": 1, }x' }).issues;
assert(iss.some((i) => i.level === 'error'));
iss = files.checkFile({ path: '~/.codex/config.toml', text: '[a]\nx = 1\n[a]\ny = 2\n' }).issues;
assert(iss.some((i) => /defined twice/.test(i.msg)));
iss = files.checkFile({ path: '~/.agents/skills/alpha/SKILL.md' }).issues;
assert(!iss.some((i) => i.level === 'error'), JSON.stringify(iss));
iss = files.checkFile({ path: '~/.agents/skills/alpha/SKILL.md', text: '# no frontmatter' }).issues;
assert(iss.some((i) => /frontmatter/.test(i.msg)));
w('.agents/skills/alpha/notes.md', 'x');
assert(files.skillFiles('alpha').some((f) => f.name === 'notes.md'));
assert(files.checkAll().files.some((f) => f.path === '~/.claude/settings.local.json'));

// edit with conflict check, path guard, disable/enable an instruction file
const rd = files.read('~/.claude/CLAUDE.md');
assert.throws(() => files.write({ path: '~/.claude/CLAUDE.md', text: 'x', mtime: rd.mtime - 5000 }), /changed on disk/);
files.write({ path: '~/.claude/CLAUDE.md', text: '# new\n', mtime: rd.mtime });
assert.strictEqual(fs.readFileSync(path.join(HOME, '.claude/CLAUDE.md'), 'utf8'), '# new\n');
assert.throws(() => files.read('../outside.txt'), /outside home/);
assert.throws(() => files.read('~/.claude/some.exe'), /not a text/);
files.setEnabled({ path: '~/.claude/CLAUDE.md', enabled: false });
assert(!has('.claude/CLAUDE.md') && has('.claude/CLAUDE.md.skm-disabled'));
files.setEnabled({ path: '~/.claude/CLAUDE.md.skm-disabled', enabled: true });
assert(has('.claude/CLAUDE.md'));

// ---------- env vars ----------
let ev = files.envScan();
const evar = (k) => ev.vars.find((v) => v.key === k);
assert(evar('GEMINI_API_KEY').value !== 'abc123' && evar('FOO').value === 'bar' && !evar('API_KEY').value.includes('secret'));
files.envSet({ source: '~/.gemini/.env', key: 'GEMINI_API_KEY', enabled: false });
assert(fs.readFileSync(path.join(HOME, '.gemini/.env'), 'utf8').startsWith('# skm-off: GEMINI_API_KEY=abc123'));
files.envSet({ source: '~/.gemini/.env', key: 'GEMINI_API_KEY', enabled: true, value: 'new value' });
assert(fs.readFileSync(path.join(HOME, '.gemini/.env'), 'utf8').startsWith('GEMINI_API_KEY="new value"'));
files.envSet({ source: '~/.claude/settings.json', key: 'FOO', enabled: false });
ev = files.envScan();
assert(!evar('FOO').enabled && !readJ('.claude/settings.json').env.FOO);
files.envSet({ source: '~/.claude/settings.json', key: 'FOO', enabled: true });
assert.strictEqual(readJ('.claude/settings.json').env.FOO, 'bar');

// ---------- redaction for "Diagnose with Claude Code" ----------
const red = files.redact('{ "apiKey": "sk-abcdefghijklmnop", "name": "x" }', 'settings');
assert(!red.includes('sk-abcdefghijklmnop') && red.includes('"name": "x"'));
assert(!files.redact('A=1\nB=secret', 'env').includes('secret'));
const merged = files.restoreRedacted({ path: '~/.gemini/.env', text: 'TOKEN=real1\nX=1', fixed: 'TOKEN=<redacted>\nX=2' });
assert.strictEqual(merged.text, 'TOKEN=real1\nX=2');

// ---------- harness registry and platform helpers ----------
assert.strictEqual(harness.idForLabel('Claude Code (demo)'), 'claude-code');
assert.strictEqual(harness.idForLabel('Claude Desktop'), 'claude-desktop');
assert.strictEqual(harness.idForLabel('Codex'), 'codex');
assert.strictEqual(harness.idForLabel('ChatGPT'), 'chatgpt');
const fake = (exe, cmd = '') => ({ exe: exe.toLowerCase().replace(/\\/g, '/'), cmd: cmd.toLowerCase().replace(/\\/g, '/'), name: '' });
const reg = (id) => harness.REGISTRY.find((h) => h.id === id);
assert(reg('claude-desktop').match(fake('C:\\Program Files\\WindowsApps\\Claude_4.1_x64__abc\\app\\claude.exe')));
assert(reg('claude-desktop').match(fake('/Applications/Claude.app/Contents/MacOS/Claude')));
assert(!reg('claude-code').match(fake('C:\\Program Files\\WindowsApps\\Claude_4.1_x64__abc\\app\\claude.exe')));
assert(reg('claude-code').match(fake('C:\\Users\\x\\.local\\bin\\claude.exe', '"C:\\Users\\x\\.local\\bin\\claude.exe"')));
assert(reg('claude-code').match(fake('/usr/bin/node', 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js')));
assert(reg('gemini').match(fake('/usr/bin/node', 'node /usr/lib/node_modules/@google/gemini-cli/dist/index.js')));
assert(reg('cursor').match(fake('/Applications/Cursor.app/Contents/MacOS/Cursor')));
assert(reg('chatgpt').match(fake('/Applications/ChatGPT.app/Contents/MacOS/ChatGPT')));
const snap = { procs: [
  Object.assign(fake('/home/u/.local/bin/claude', '/home/u/.local/bin/claude'), { pid: 10, ppid: 1, rawExe: '', rawCmd: '' }),
  Object.assign(fake('/home/u/.local/bin/claude', '/home/u/.local/bin/claude daemon run'), { pid: 11, ppid: 1, rawExe: '', rawCmd: '' }),
  Object.assign(fake('/home/u/.local/bin/claude', '/home/u/.local/bin/claude -p hi'), { pid: 12, ppid: 1, rawExe: '', rawCmd: '' }),
] };
assert.deepStrictEqual(harness.instancesOf(reg('claude-code'), snap).map((i) => i.pid), [10], 'skips daemon and -p runs');
const regOut = '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin\r\n    MY_VAR    REG_SZ    hello world\r\n';
assert.deepStrictEqual(P.parseRegQuery(regOut), { Path: { value: '%USERPROFILE%\\bin', expand: true }, MY_VAR: { value: 'hello world', expand: false } });
const launcher = P.writeLauncher('echo hi', HOME, { A: 'b c' });
assert(fs.readFileSync(launcher, 'utf8').includes(P.IS_WIN ? 'set "A=b c"' : "export A='b c'"));
const fe = P.freshEnv();
assert(fe.PATH || fe.Path, 'fresh env has PATH');
assert(!Object.keys(fe).some((k) => k.startsWith('SKM_')), 'fresh env drops SKM_ vars');

// ---------- MCP server processes ----------
const mcpproc = require('./lib/mcpproc');
assert.deepStrictEqual(mcpproc.keysFor('npx -y @playwright/mcp@latest'), ['@playwright/mcp']);
assert.deepStrictEqual(mcpproc.keysFor('node C:\\srv\\index.js --api-key sk-abc'), ['c:/srv/index.js']);
assert.strictEqual(mcpproc.localPort('http://127.0.0.1:4937/mcp'), 4937);
assert.strictEqual(mcpproc.localPort('https://example.com/mcp'), null);
(async () => {
  const script = path.join(HOME, 'fake-mcp-' + Date.now(), 'server.js');
  w(path.relative(HOME, script), 'setInterval(() => {}, 1000);');
  w('.cursor/mcp.json', JSON.stringify({ mcpServers: { fakesrv: { command: 'node', args: [script] } } }));
  const child = require('child_process').spawn(process.execPath, [script], { stdio: 'ignore' });
  await new Promise((res) => setTimeout(res, 800));
  const found = mcpproc.find();
  assert(found.fakesrv && found.fakesrv.some((p) => p.pid === child.pid), 'finds the running server process');
  const rr = await mcpproc.restart({ names: ['fakesrv'] });
  assert.strictEqual(rr.results[0].stopped, 1, JSON.stringify(rr));
  assert(!P.alive(child.pid), 'server process ended');
  // ---------- stop / start all (no real processes or apps: terminate and launchers are stubbed) ----------
  const U = require('./lib/util');
  const cc = reg('claude-code'), cursor = reg('cursor');
  const stoppedNow = () => U.loadState().stoppedHarnesses || {};
  // pure planning
  const gp = harness.planStart(cursor, { at: 'x', gui: { exe: 'C:/x/Cursor.exe', msixAppId: null }, cli: [] }, { running: 0, exe: 'C:/other.exe' });
  assert.strictEqual(gp.gui.exe, 'C:/x/Cursor.exe', 'GUI relaunches the recorded exe');
  assert(harness.planStart(cursor, null, { running: 0, exe: 'C:/other.exe' }).gui.exe === 'C:/other.exe', 'no record: one instance from the install');
  const gr = harness.planStart(cursor, null, { running: 2, exe: 'C:/other.exe' });
  assert(gr.skipped && !gr.gui && gr.notes[0] === 'already running', 'GUI already running is skipped');
  const cp = harness.planStart(cc, { at: 'x', gui: null, cli: [{ cwd: '/a', command: 'claude --continue' }, { cwd: '/b', command: 'claude -r' }] }, { running: 1, command: 'ignored', defaultCwd: '/h' });
  assert.deepStrictEqual(cp.terminals, [{ cwd: '/a', command: 'claude --continue' }, { cwd: '/b', command: 'claude -r' }], 'CLI: one terminal per recorded instance, even if already running');
  assert.deepStrictEqual(harness.planStart(cc, null, { command: 'claude --continue', defaultCwd: '/h' }).terminals, [{ cwd: '/h', command: 'claude --continue' }], 'no record: one terminal');
  assert.strictEqual(harness.mergeStopRecords({ at: 'a', gui: null, cli: [{ cwd: '/a', command: 'c' }] }, { at: 'b', gui: null, cli: [{ cwd: '/b', command: 'c' }] }).cli.length, 2, 'stopping twice accumulates');

  const launched = { gui: [], term: [] };
  const orig = { terminate: P.terminate, launchGui: P.launchGui, openTerminal: P.openTerminal, freshEnv: P.freshEnv };
  let terminated = [];
  P.terminate = async (pids) => { terminated.push(...pids); return { closed: pids.length, forced: 0 }; };
  P.launchGui = (o) => { launched.gui.push(o); };
  P.openTerminal = (command, cwd) => { launched.term.push({ command, cwd }); };
  P.freshEnv = () => ({ PATH: 'x' });
  try {
    harness.setPrefs({ id: 'claude-code', cwd: HOME });
    const proc = (id, pid, exe, cmd) => Object.assign(fake(exe, cmd), { pid, ppid: 1, rawExe: exe, rawCmd: cmd });
    const fsnap = { procs: [
      proc('cc', 31, '/home/u/.local/bin/claude', '/home/u/.local/bin/claude'),
      proc('cc', 32, '/home/u/.local/bin/claude', '/home/u/.local/bin/claude'),
      proc('cur', 41, 'C:/Users/u/AppData/Local/Programs/cursor/Cursor.exe', 'C:/Users/u/AppData/Local/Programs/cursor/Cursor.exe'),
    ] };
    assert.strictEqual(harness.instancesOf(cc, fsnap).length, 2);

    // stop saves the record, ends only what was targeted, and starts nothing
    const sc = await harness.stopOne(cc, fsnap);
    assert.deepStrictEqual(terminated, [31, 32]);
    assert.deepStrictEqual(Object.keys(sc.result).sort(), ['closed', 'forced', 'id', 'label', 'launched', 'notes']);
    const rec = stoppedNow()['claude-code'];
    assert(rec && rec.at && rec.gui === null && rec.cli.length === 2, JSON.stringify(rec));
    assert.deepStrictEqual(rec.cli[0], { cwd: HOME, command: 'claude --continue' });
    assert.strictEqual(harness.stoppedCount(rec), 2);
    const sg = await harness.stopOne(cursor, fsnap);
    assert(stoppedNow().cursor.gui.exe.toLowerCase().endsWith('cursor.exe') && stoppedNow().cursor.cli.length === 0);
    assert(sg.result.closed === 1 && launched.gui.length === 0 && launched.term.length === 0, 'stop launches nothing');
    const hs = harness.status().harnesses.find((x) => x.id === 'claude-code');
    assert(!hs || hs.stoppedCount === 2, 'status reports stopped count');

    // start reopens exactly the record, then clears it
    const none = { procs: [] };
    const sr = await harness.startOne(cc, none);
    assert.strictEqual(sr.launched, 2);
    assert.deepStrictEqual(launched.term.map((t) => t.command), ['claude --continue', 'claude --continue']);
    assert(!stoppedNow()['claude-code'], 'record cleared after start');
    await harness.startOne(cursor, none);
    assert(launched.gui.length === 1 && /cursor\.exe$/i.test(launched.gui[0].exe) && !stoppedNow().cursor);

    // start all with no records: nothing launched, says so
    const before = launched.gui.length + launched.term.length;
    const na = await harness.start({ ids: ['*'] });
    assert.deepStrictEqual([na.results.length, na.errors.length], [0, 0]);
    assert(/nothing to start/i.test(na.message), na.message);
    assert.strictEqual(launched.gui.length + launched.term.length, before, 'nothing launched');

    // restart keeps its results shape, closes then reopens, and leaves no stop record
    terminated = []; launched.term.length = 0;
    const rs = await harness.restartOne(cc, fsnap);
    assert.deepStrictEqual(rs, { id: 'claude-code', label: 'Claude Code', closed: 2, forced: 0, launched: 2, notes: rs.notes });
    assert.deepStrictEqual(terminated, [31, 32]);
    assert.strictEqual(launched.term.length, 2);
    assert(!stoppedNow()['claude-code'], 'restart leaves no record');
    assert.deepStrictEqual(await harness.restartOne(cc, none, { startIfStopped: false }), { id: 'claude-code', label: 'Claude Code', closed: 0, forced: 0, launched: 0, notes: ['not running'] });

    // ---------- per-instance stop / start ----------
    const dirB = path.join(HOME, 'proj-b');
    fs.mkdirSync(dirB, { recursive: true });
    const tr = { at: 'x', gui: null, cli: [{ cwd: '/a', command: 'c1' }, { cwd: dirB, command: 'c2' }, { cwd: '/c', command: 'c3' }] };
    const t1 = harness.takeRecordEntry(tr, 1);
    assert.deepStrictEqual(t1.entry, { cwd: dirB, command: 'c2' });
    assert.deepStrictEqual(t1.rest.cli, [{ cwd: '/a', command: 'c1' }, { cwd: '/c', command: 'c3' }], 'removes exactly one entry');
    assert.strictEqual(tr.cli.length, 3, 'input record not mutated');
    const last = harness.takeRecordEntry({ at: 'x', gui: null, cli: [{ cwd: '/a', command: 'c1' }] }, 0);
    assert(last.entry && last.rest === null, 'last entry leaves no record');
    assert(harness.takeRecordEntry(tr, 9).entry === null && harness.takeRecordEntry(null, 0).entry === null, 'out of range / no record: no entry');
    assert.deepStrictEqual(harness.takeRecordEntry({ at: 'x', gui: { exe: 'E', msixAppId: null }, cli: [] }, 0).entry, { exe: 'E', msixAppId: null });

    // stopping one pid terminates only that pid and records one entry
    terminated = []; launched.term.length = 0;
    const sone = await harness.stopOne(cc, fsnap, { pids: [32] });
    assert.deepStrictEqual(terminated.slice(-1), [32], 'only the chosen pid is terminated');
    assert(!terminated.includes(31), 'other instance left alone');
    assert.strictEqual(sone.record.cli.length, 1);
    U.saveState(Object.assign(U.loadState(), { stoppedHarnesses: {} }));

    // start one recorded entry: one terminal, the others stay recorded
    harness.saveStopRecord('claude-code', tr);
    launched.term.length = 0;
    const si = await harness.startInstance({ id: 'claude-code', index: 1 });
    assert.deepStrictEqual(si.errors, []);
    assert.deepStrictEqual(Object.keys(si.results[0]).sort(), ['closed', 'forced', 'id', 'label', 'launched', 'notes']);
    assert.deepStrictEqual(launched.term, [{ command: 'c2', cwd: dirB }], 'one terminal with the recorded cwd and command');
    assert.deepStrictEqual(stoppedNow()['claude-code'].cli.map((c) => c.command), ['c1', 'c3'], 'others stay in the record');

    // start one fresh instance: one terminal, record untouched
    launched.term.length = 0;
    const sf = await harness.startInstance({ id: 'claude-code' });
    assert.strictEqual(sf.results[0].launched, 1);
    assert.strictEqual(launched.term.length, 1);
    assert.strictEqual(launched.term[0].command, 'claude --continue');
    assert.strictEqual(stoppedNow()['claude-code'].cli.length, 2, 'record untouched by a fresh start');
    assert.strictEqual((await harness.startInstance({ id: 'nope' })).errors.length, 1);
    U.saveState(Object.assign(U.loadState(), { stoppedHarnesses: {} }));
  } finally { Object.assign(P, orig); }

  fs.rmSync(HOME, { recursive: true, force: true });
  console.log('all config sandbox tests passed');
})().catch((e) => { console.error(e); process.exitCode = 1; });
