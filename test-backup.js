'use strict';
// Sandbox test for backup and restore, and for skills that come with plugins.
// Never touches the real home. Run: node test-backup.js (test.js runs it too).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-test3-'));
process.env.SKM_HOME = HOME;
const P = require('./lib/platform');
const backup = require('./lib/backup');
const skills = require('./lib/skills');

const w = (p, t) => { fs.mkdirSync(path.dirname(path.join(HOME, p)), { recursive: true }); fs.writeFileSync(path.join(HOME, p), t); };
const r = (p) => fs.readFileSync(path.join(HOME, p), 'utf8');
const has = (p) => fs.existsSync(path.join(HOME, p));
const isLink = (p) => { try { return fs.lstatSync(path.join(HOME, p)).isSymbolicLink(); } catch { return false; } };

// a small machine: store skill linked into a harness, a real harness skill, MCP config, plugin
// switches, instructions, an .env file with a secret
w('.agents/skills/alpha/SKILL.md', '---\nname: alpha\ndescription: Alpha\n---\n');
w('.agents/skills/alpha/scripts/run.sh', 'echo alpha');
w('.agents/skills/alpha/node_modules/big/index.js', 'skipped');
w('.agents/.skill-lock.json', JSON.stringify({ version: 3, skills: { alpha: { source: 'me/alpha' } } }));
fs.mkdirSync(path.join(HOME, '.claude/skills'), { recursive: true });
fs.symlinkSync(path.join(HOME, '.agents/skills/alpha'), path.join(HOME, '.claude/skills/alpha'), 'junction');
w('.claude/skills/mine/SKILL.md', '---\nname: mine\ndescription: Mine\n---\n');
w('.claude.json', JSON.stringify({ mcpServers: { a: { command: 'npx', args: ['a'] } } }, null, 2));
w('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'p@m': true } }, null, 2));
w('.claude/CLAUDE.md', '# rules\n');
w('.codex/config.toml', 'model = "x"\n\n[plugins."cp@mk"]\nenabled = true\n');
w('.gemini/.env', 'GEMINI_API_KEY=supersecret\n');
const appCfg = path.relative(HOME, path.join(P.appData(), 'Claude', 'claude_desktop_config.json'));
w(appCfg, JSON.stringify({ mcpServers: { d: { command: 'node' } } }));

// ---------- path tokens ----------
assert.strictEqual(backup.toToken(path.join(HOME, '.claude.json')), '~/.claude.json');
assert.strictEqual(backup.toToken(path.join(P.appData(), 'Claude', 'x.json')), '$APPDATA/Claude/x.json');
assert.strictEqual(backup.fromToken('~/.claude.json'), path.join(HOME, '.claude.json'));
assert.throws(() => backup.fromToken('~/../evil'), /outside|unsafe/);
assert.throws(() => backup.fromToken('/etc/passwd'), /bad path/);

// ---------- what goes in ----------
const est = backup.estimate({ cats: backup.DEFAULT_CATS });
assert(est.byCat.skills.items >= 3 && est.byCat.mcp.items >= 2, JSON.stringify(est.byCat));
const items = backup.collect(backup.DEFAULT_CATS);
const byRel = (rel) => items.find((i) => i.rel === rel);
assert.strictEqual(byRel('~/.claude/skills/alpha').type, 'link');
assert.strictEqual(byRel('~/.claude/skills/alpha').target, '~/.agents/skills/alpha');
assert.strictEqual(byRel('~/.claude/skills/mine').type, 'dir');
assert(byRel('$APPDATA/Claude/claude_desktop_config.json'), 'app-data config included');
assert(!items.some((i) => i.rel === '~/.gemini/.env'), '.env files are opt-in');
assert(backup.collect(['env']).some((i) => i.rel === '~/.gemini/.env'), '.env included when asked');

// ---------- create (plain) and restore after damage ----------
const made = backup.create({ cats: backup.DEFAULT_CATS, label: 'before' });
assert(made.name.endsWith('-before.hcmbackup') && !made.encrypted && made.items > 0);
const listed = backup.list().backups;
assert.strictEqual(listed[0].name, made.name);
assert.strictEqual(listed[0].includesEnv, false);
// the zip never holds the skipped node_modules or the secret
const raw = fs.readFileSync(path.join(HOME, '.skill-manager', 'snapshots', made.name));
assert(!raw.includes(Buffer.from('supersecret')));
const un = backup.unpack(raw);
assert(!un.manifest.items.some((m) => (m.files || []).some((f) => f.p.includes('node_modules'))));

// break things
w('.claude.json', '{ "broken": true }');
fs.rmSync(path.join(HOME, '.agents/skills/alpha'), { recursive: true, force: true });
fs.unlinkSync(path.join(HOME, '.claude/skills/alpha')) ;
w('.claude/skills/mine/SKILL.md', 'edited');
fs.unlinkSync(path.join(HOME, appCfg));

let ins = backup.inspect({ name: made.name });
const st = (rel) => ins.items.find((i) => i.rel === rel).status;
assert.strictEqual(st('~/.claude.json'), 'changed');
assert.strictEqual(st('~/.agents/skills/alpha'), 'new');
assert.strictEqual(st('~/.claude/skills/alpha'), 'new');
assert.strictEqual(st('~/.claude/skills/mine'), 'changed');
assert.strictEqual(st('~/.claude/CLAUDE.md'), 'same');

let res = backup.restore({ name: made.name });
assert.deepStrictEqual(res.errors, []);
assert(res.changed >= 5 && res.skipped >= 1, JSON.stringify(res));
assert.deepStrictEqual(JSON.parse(r('.claude.json')).mcpServers.a, { command: 'npx', args: ['a'] });
assert.strictEqual(r('.agents/skills/alpha/scripts/run.sh'), 'echo alpha');
assert(isLink('.claude/skills/alpha') && has('.claude/skills/alpha/SKILL.md'), 'link recreated after its target');
assert(r('.claude/skills/mine/SKILL.md').includes('name: mine'));
assert(has(appCfg), 'app-data file restored');
// what the restore replaced was kept, not deleted
assert(res.replacedTo && fs.readdirSync(path.join(HOME, res.replacedTo.replace(/^~\//, ''))).length >= 2);
ins = backup.inspect({ name: made.name });
assert(ins.items.every((i) => i.status === 'same'), JSON.stringify(ins.items.filter((i) => i.status !== 'same')));
// restore of only one category touches nothing else
w('.claude.json', '{ "broken": 2 }');
w('.claude/CLAUDE.md', 'changed rules');
res = backup.restore({ name: made.name, cats: ['mcp'] });
assert(r('.claude.json').includes('mcpServers') && r('.claude/CLAUDE.md') === 'changed rules');

// ---------- encrypted, with env ----------
assert.throws(() => backup.create({ cats: ['env'], password: 'short' }), /8 characters/);
const enc = backup.create({ cats: ['env', 'mcp'], password: 'correct horse' });
assert(enc.encrypted);
const encRaw = fs.readFileSync(path.join(HOME, '.skill-manager', 'snapshots', enc.name));
assert(!encRaw.includes(Buffer.from('supersecret')) && !encRaw.includes(Buffer.from('mcpServers')), 'payload is encrypted');
assert.strictEqual(backup.list().backups.find((b) => b.name === enc.name).includesEnv, true);
assert.throws(() => backup.inspect({ name: enc.name }), /password/);
assert.throws(() => backup.inspect({ name: enc.name, password: 'wrong password' }), /wrong password/);
w('.gemini/.env', 'GEMINI_API_KEY=changed\n');
res = backup.restore({ name: enc.name, password: 'correct horse', cats: ['env'] });
assert.deepStrictEqual(res.errors, []);
assert.strictEqual(r('.gemini/.env'), 'GEMINI_API_KEY=supersecret\n');
// a backup from bytes (an uploaded file) works the same
assert(backup.inspect({ b64: encRaw.toString('base64'), password: 'correct horse' }).items.length > 0);
assert.throws(() => backup.inspect({ name: '../x.hcmbackup' }), /bad backup name/);
assert.throws(() => backup.unpack(Buffer.from('nope')), /not a Harness/);

// copy out
const outDir = path.join(HOME, 'usb'); fs.mkdirSync(outDir);
backup.copyTo({ name: made.name, folder: outDir });
assert(fs.existsSync(path.join(outDir, made.name)));
assert.throws(() => backup.copyTo({ name: made.name, folder: outDir }), /already exists/);

// ---------- skills that come with plugins ----------
w('.codex/skills/.system/imagegen/SKILL.md', '---\nname: imagegen\ndescription: Built in\n---\n');
w('.codex/plugins/cache/mk/cp/1.0.0/.codex-plugin/plugin.json', JSON.stringify({ name: 'cp', version: '1.0.0' }));
w('.codex/plugins/cache/mk/cp/1.0.0/skills/plug-skill/SKILL.md', '---\nname: plug-skill\ndescription: From a plugin\n---\n');
let sc = skills.scan();
const ps = sc.skills.find((s) => s.name === 'plug-skill');
assert(ps && ps.installs[0].kind === 'plugin' && ps.installs[0].plugin === 'cp' && ps.installs[0].readOnly && ps.installs[0].harness === 'codex');
assert.strictEqual(sc.skills.find((s) => s.name === 'imagegen').installs[0].plugin, 'built-in');
// toggling leaves plugin skills alone and says why
const t = skills.setEnabled({ names: ['plug-skill'], harnesses: null, enabled: false });
assert.strictEqual(t.changed, 0);
assert(/plugin cp/.test(t.errors.join()));
assert(has('.codex/plugins/cache/mk/cp/1.0.0/skills/plug-skill/SKILL.md'));
// a disabled plugin's skills are not listed
w('.codex/config.toml', 'model = "x"\n\n[plugins."cp@mk"]\nenabled = false\n');
sc = skills.scan();
assert(!sc.skills.some((s) => s.name === 'plug-skill' && s.installs.some((i) => i.kind === 'plugin')));

fs.rmSync(HOME, { recursive: true, force: true });
console.log('all backup sandbox tests passed');
