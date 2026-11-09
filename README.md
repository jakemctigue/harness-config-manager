# Harness Config Manager

**Drowning in skills? Want a GUI to configure config files? Here's an easy way to manage them all.**

Every AI coding harness keeps its own skills folder, MCP config, plugins and env vars. Once you run a few of them, the same skill is installed in dozens of places, and a broken setting can be hard to find. Harness Config Manager puts all of it in one local window.

## What it does

- **Skills:** search hundreds of skills across every harness, then disable or uninstall them in bulk. Uninstalled skills go to a Trash you can restore from.
- **MCP servers:** turn servers on or off in each harness's config, see which processes are running and who owns them, and restart them.
- **Plugins and extensions:** switch Claude Code and Codex plugins, Gemini CLI extensions and Claude Desktop extensions on or off.
- **`.mcpb` bundles:** drop a bundle on the window to install it into Claude Desktop or any harness.
- **Config files:** edit `.claude.json`, `settings.json`, YAML, TOML, `CLAUDE.md`, `AGENTS.md` and the text files inside skills.
- **Env vars:** see every `.env` variable in one list, with secret-looking values masked, and turn them on or off.
- **Find what's wrong:** built-in checks catch broken config, missing commands and bad paths. Claude Code can also diagnose a file and suggest a fix for you to review. Secrets are hidden from it first.
- **Restart from a button:** restart one harness or all of them so they pick up the new env vars, skills and settings.

Files are backed up before they change, and nothing is hard-deleted. The app only listens on your own machine.

## Get started

You need [Node.js](https://nodejs.org) 18 or newer. There's nothing else to install.

| OS | Start it with |
|---|---|
| Windows | Double-click `start.cmd` |
| Linux or WSL | `./start.sh` |
| macOS | Double-click `start.command` |

**Tested on:** Windows and WSL. It has **not been tested on macOS** yet.

See the [full guide](docs/GUIDE.md) for how each feature works.

## License

[MIT](LICENSE)
