# Harness Config Manager

**Drowning in skills? Want a GUI to configure config files? Here's an easy way to manage them all.**

Every AI coding harness keeps its own skills folder, MCP config, plugins and env vars. Claude Code, Codex, the ChatGPT app, Claude Desktop, Cursor, Gemini CLI, VS Code and dozens more each do it their own way. Once you run a few of them, the same skill is installed in dozens of places, an MCP server is configured in five files, and a broken setting can take an afternoon to find.

Harness Config Manager puts all of it in one local window. You can see everything every harness on your machine is set up with, switch things on and off in bulk, fix what's broken, and restart the harnesses so the change takes effect, without hand-editing a dozen config files.

## Why use it

- **See everything in one place.** Every skill, MCP server, plugin, extension, config file and env var across about 80 harnesses, with search and filters.
- **Change things safely.** Every file is backed up before it changes, every switch can be turned back, and nothing is ever hard-deleted. Uninstalled skills go to a Trash you can restore from.
- **Find what's broken.** Built-in checks catch broken config, missing commands and bad paths. Claude Code can diagnose a file and suggest a fix for you to review, with secrets hidden from it first.
- **Apply changes without hunting for windows.** Restart one harness, one instance or all of them from a button, so they pick up new env vars, skills and settings.
- **Private.** It runs only on your machine. The only thing that ever leaves it is a file you choose to send to Claude Code for diagnosis, with secrets hidden first.

## What it covers

- **Skills:** search hundreds of skills across every harness, including the ones plugins bring, then disable or uninstall them in bulk.
- **MCP servers:** turn servers on or off in each harness's config, see which processes are running and which harness owns them, and restart them.
- **Plugins and extensions:** Claude Code plugins, Codex / ChatGPT app plugins, Gemini CLI extensions and Claude Desktop extensions.
- **`.mcpb` bundles:** drop a bundle on the window to install it into Claude Desktop or any harness.
- **Config files:** edit `.claude.json`, `settings.json`, YAML, TOML, `CLAUDE.md`, `AGENTS.md` and the text files inside skills.
- **Env vars:** every `.env` variable in one list, with secret-looking values masked.
- **Harnesses:** which harnesses are installed and running, with Stop, Start and Restart for each one and each instance.
- **Backup and restore:** save skills, MCP configs, plugin switches, settings and (if you choose) `.env` files and Windows user environment variables to one file, optionally password-encrypted, and restore all or part of it later or on another machine.
- **Microsoft Store apps on Windows:** ChatGPT (the Codex app), ChatGPT (Beta), ChatGPT Classic and Claude Desktop are found even when they're closed, including the files Windows keeps in their private folders.

## Install

There are two versions with the same features:

- **Desktop app (Windows):** a normal Windows app with an installer, a Start menu entry and no console window. It doesn't need Node.js once installed.
- **Command version (Windows, macOS, Linux):** run it from this folder with Node.js. It opens in a browser app window.

### Windows: desktop app

You need [Node.js](https://nodejs.org) 18 or newer and [Git](https://git-scm.com) to build the installer.

```
git clone https://github.com/jakemctigue/harness-config-manager.git
cd harness-config-manager
npm install
npm run dist
```

Then run `dist\Harness-Config-Manager-Setup-<version>.exe`. It installs for your user without admin rights, or for all users if you choose. The installer isn't code-signed, so Windows SmartScreen may warn the first time; click **More info > Run anyway**. To update, build and run a newer installer over the old one, and your settings are kept.

### Windows, macOS and Linux: command version

You need [Node.js](https://nodejs.org) 18 or newer. There's nothing else to install: no `npm install`, no dependencies.

Get the code with `git clone https://github.com/jakemctigue/harness-config-manager.git`, or download it with **Code > Download ZIP** on GitHub and unzip it. Then start it:

| OS | Start it with |
|---|---|
| Windows | Double-click `start.cmd` |
| macOS | Double-click `start.command` (the first time: right-click it and choose **Open**) |
| Linux or WSL | `./start.sh` in a terminal |
| Any | `node server.js` (or `npm start`) |

It opens in a chromeless window if Chrome, Edge, Brave or Chromium is installed, otherwise in your default browser. Close the terminal window or press Ctrl+C to stop it. To update, run `git pull` (or download the ZIP again).

## Tested on

- **Windows 11:** the desktop app and the command version.
- **Linux:** the command version and the full test suite under WSL (Ubuntu 24.04, Node 22).
- **macOS:** not tested yet. It should work, and reports are welcome.

See the [full guide](docs/GUIDE.md) for how each feature works.

## License

[MIT](LICENSE)
