'use strict';
// Sandbox test: builds a fake home with a skill store, junction-linked harnesses, a real skill
// folder, a JSON MCP config and a Codex TOML config, then round-trips every operation.
// Never touches the real home. Run: node test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-test-'));
process.env.SKM_HOME = HOME;
const skills = require('./lib/skills');
const mcp = require('./lib/mcp');

const w = (p, t) => { fs.mkdirSync(path.dirname(path.join(HOME, p)), { recursive: true }); fs.writeFileSync(path.join(HOME, p), t); };
const link = (target, p) => { fs.mkdirSync(path.dirname(path.join(HOME, p)), { recursive: true }); fs.symlinkSync(path.join(HOME, target), path.join(HOME, p), 'junction'); };
const isLink = (p) => { try { return fs.lstatSync(path.join(HOME, p)).isSymbolicLink(); } catch { return false; } };
const has = (p) => fs.existsSync(path.join(HOME, p));

for (const n of ['alpha', 'beta']) w(`.agents/skills/${n}/SKILL.md`, `---\nname: ${n}\ndescription: >\n  The ${n} skill\n  does things\n---\n# ${n}\n`);
w('.agents/.skill-lock.json', JSON.stringify({ version: 3, skills: { alpha: { source: 'me/alpha' }, beta: { source: 'me/beta' } } }));
for (const h of ['.claude', '.foo', '.config/bar']) { link('.agents/skills/alpha', `${h}/skills/alpha`); link('.agents/skills/beta', `${h}/skills/beta`); }
w('.claude/skills/local-one/SKILL.md', '---\nname: local-one\ndescription: "Local only"\n---\n');
w('.claude.json', JSON.stringify({ numStartups: 3, mcpServers: { a: { command: 'npx', args: ['a'] }, b: { url: 'http://x' } },
  projects: { 'C:/p/demo': { mcpServers: { c: { command: 'c' } } } } }, null, 2));
const toml = 'model = "x"\n\n[mcp_servers.one]\ncommand = "npx"\nargs = ["one"]\n\n[mcp_servers.one.env]\nK = "v"\n\n# next\n[mcp_servers."two-x"]\nurl = "http://two"\n\n[profiles.a]\nm = 1\n';
w('.codex/config.toml', toml);
w('.cursor/mcp.json', '{\n  // comment\n  "mcpServers": { "z": { "command": "z" } }\n}\n');

let s = skills.scan();
const byName = (n) => s.skills.find((x) => x.name === n);
assert.deepStrictEqual(s.harnesses.map((h) => h.id).sort(), ['claude', 'config/bar', 'foo']);
assert.strictEqual(byName('alpha').installs.length, 3);
assert.strictEqual(byName('alpha').description, 'The alpha skill does things');
assert.strictEqual(byName('local-one').inStore, false);

// per-harness disable / enable of a junction
let r = skills.setEnabled({ names: ['alpha'], harnesses: ['foo'], enabled: false });
assert.strictEqual(r.changed, 1, r.errors.join());
assert(!has('.foo/skills/alpha') && has('.agents/skills/alpha/SKILL.md'), 'junction removed, store intact');
r = skills.setEnabled({ names: ['alpha'], harnesses: ['foo'], enabled: true });
assert(isLink('.foo/skills/alpha') && has('.foo/skills/alpha/SKILL.md'), 'junction recreated');

// all-harness disable, real-folder disable
r = skills.setEnabled({ names: ['beta', 'local-one'], harnesses: null, enabled: false });
assert.strictEqual(r.changed, 4, r.errors.join());
assert(!has('.claude/skills/local-one') && has('.skill-manager/disabled/claude/local-one/SKILL.md'));
s = skills.scan();
assert(byName('beta').installs.every((i) => !i.enabled));
r = skills.setEnabled({ names: ['beta', 'local-one'], harnesses: null, enabled: true });
assert.strictEqual(r.changed, 4, r.errors.join());
assert(has('.claude/skills/local-one/SKILL.md') && isLink('.config/bar/skills/beta'));

// prune and restore
r = skills.prune({ names: ['beta'] });
assert.strictEqual(r.changed, 1, r.errors.join());
assert(!has('.agents/skills/beta') && !has('.claude/skills/beta'));
assert(!JSON.parse(fs.readFileSync(path.join(HOME, '.agents/.skill-lock.json'))).skills.beta);
s = skills.scan();
assert(byName('beta').trashed && s.trash.length === 1);
r = skills.restore({ names: ['beta'] });
assert.strictEqual(r.changed, 1, r.errors.join());
assert(has('.agents/skills/beta/SKILL.md') && isLink('.claude/skills/beta') && has('.foo/skills/beta/SKILL.md'));
assert(JSON.parse(fs.readFileSync(path.join(HOME, '.agents/.skill-lock.json'))).skills.beta);

// MCP: JSON (top level + project scope), TOML, read-only JSONC
let m = mcp.scan();
const srv = (n) => m.servers.find((x) => x.name === n);
assert.strictEqual(srv('z').installs[0].editable, false);
assert.strictEqual(srv('one').installs[0].summary, 'npx one');
const claudeHid = 'Claude Code|' + path.join(HOME, '.claude.json');
r = mcp.setEnabled({ targets: [{ name: 'a', hid: claudeHid }, { name: 'c' }, { name: 'one' }, { name: 'z' }], enabled: false });
assert.strictEqual(r.changed, 3, r.errors.join());
assert.strictEqual(r.errors.length, 1); // z is read-only
const cj = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json')));
assert(!cj.mcpServers.a && cj.mcpServers.b && cj.numStartups === 3 && !cj.projects['C:/p/demo'].mcpServers.c);
const t1 = fs.readFileSync(path.join(HOME, '.codex/config.toml'), 'utf8');
assert(!t1.includes('mcp_servers.one') && t1.includes('# next') && t1.includes('[mcp_servers."two-x"]') && t1.includes('[profiles.a]'));
r = mcp.setEnabled({ targets: [{ name: 'a' }, { name: 'c' }, { name: 'one' }], enabled: true });
assert.strictEqual(r.changed, 3, r.errors.join());
const cj2 = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json')));
assert.deepStrictEqual(cj2.mcpServers.a, { command: 'npx', args: ['one'.replace('one', 'a')] });
assert.deepStrictEqual(cj2.projects['C:/p/demo'].mcpServers.c, { command: 'c' });
const t2 = fs.readFileSync(path.join(HOME, '.codex/config.toml'), 'utf8');
assert(t2.includes('[mcp_servers.one]') && t2.includes('[mcp_servers.one.env]') && t2.includes('K = "v"'));
assert(fs.readdirSync(path.join(HOME, '.skill-manager/backups')).length >= 1, 'backups written');

fs.rmSync(HOME, { recursive: true, force: true });
console.log('all sandbox tests passed');

// The config tests need their own sandbox home (paths are fixed at require time), so run them in a child.
const run = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'test-config.js')], { stdio: 'inherit', env: Object.assign({}, process.env, { SKM_HOME: '' }) });
process.exitCode = run.status;
