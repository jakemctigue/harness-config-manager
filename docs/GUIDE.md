# Harness Config Manager: full guide

A local app for configuring every AI coding harness on your machine from one window: skills, MCP servers, plugins, extensions, `.mcpb` bundles, config files (`~/.claude.json`, `settings.json`, YAML, TOML, `CLAUDE.md`, `AGENTS.md`...), `.env` files and the flat text files inside skills. It can check those files for problems, ask Claude Code to diagnose them and suggest fixes, and restart one harness or all of them so they pick up the changes.

Built to run natively on **Windows, macOS and Linux** with nothing but Node.js 18+ (no dependencies, no install step). On Windows there is also a desktop app with an installer that needs no Node.js (see [Desktop app](#desktop-app)).

**Tested on:** Windows and WSL. It has **not been tested on macOS** yet.

## Start

| OS | How |
|---|---|
| Windows | Double-click `start.cmd` |
| macOS | Double-click `start.command` (first time: right-click > Open) |
| Linux | `./start.sh` |
| Any | `node server.js` |

It opens a chromeless app window (Edge, Chrome, Brave or Chromium; otherwise your default browser). Closing the console window, or Ctrl+C, stops it. `node server.js some-bundle.mcpb` (or `start.cmd some-bundle.mcpb`) starts straight into the installer for that bundle, so you can point a file association at it.

## Desktop app

The desktop app is the same window and the same features in a native Windows app: its own icon, taskbar entry and Start menu shortcut, no console window, and nothing listening on a local port.

**Install:** run `Harness-Config-Manager-Setup-<version>.exe`. It installs for your user only and needs no admin rights or Node.js. Uninstall it from Windows Settings > Apps.

**Open a bundle:** drop a `.mcpb` / `.dxt` on the window, use **Install .mcpb…**, or right-click a bundle in Explorer and choose **Open with > Harness Config Manager**. The installer adds the app to the **Open with** list but leaves your default app for `.mcpb` alone, because **Open in Claude Desktop** hands the bundle to that default app. If the app is already open, the bundle opens in the running window.

**Build it from a checkout** (needs Node.js 18+):

```
npm install          # Electron and electron-builder, used only to run and package the app
npm run desktop      # run the desktop app from the checkout
npm run dist         # build dist/Harness-Config-Manager-Setup-<version>.exe
npm run dist:dir     # build only dist/win-unpacked (no installer), for a quick test
```

The installer is not code-signed, so the first time you run it Windows SmartScreen may say it "protected your PC". Click **More info > Run anyway**. The `mac` and `linux` targets in `package.json` have not been built or tested yet.

How it fits together: `lib/routes.js` holds every action the UI can ask for. `server.js` serves those actions over local HTTP for the browser version, and `desktop/main.js` serves the same actions to the window over Electron IPC. `desktop/preload.js` is the only bridge between the page and the app, and the page runs sandboxed without Node.js access.

## Tabs

| Tab | What it covers | How a toggle works |
|---|---|---|
| **Skills** | `~/.agents/skills` plus every `~/.<harness>/skills` folder (about 80 harnesses), plus the skills that enabled Codex / ChatGPT app and Claude Code plugins bring and Codex's built-in ones (`~/.codex/skills/.system`). Search, filter, select many, then **Disable**, **Enable** or **Uninstall (to Trash)**. **Edit skill files…** opens every text file in a skill. | Disable removes that harness's link (or moves a real folder to `~/.skill-manager/disabled`). Uninstall moves the store copy to `~/.skill-manager/trash`; the Trash tab restores it. Plugin and built-in skills are read-only: switch their plugin off in Plugins & extensions. |
| **MCP servers** | About 50 config locations (Claude Code incl. project scopes in `~/.claude.json`, Claude Desktop, Codex / ChatGPT app TOML, Cursor, Windsurf, Gemini, VS Code, Cline, Roo, Zed, opencode, Goose...), Microsoft Store apps' own copies (see below), and the servers that enabled Codex plugins bring. | The entry is cut out of the config (backed up first) and kept verbatim, and Enable writes it back. Plugin servers are read-only: switch the plugin off instead. |
| **Plugins & extensions** | Claude Code plugins, Codex / ChatGPT app plugins (with the version, description, skills and MCP server each brings, from `~/.codex/plugins/cache`), Gemini CLI extensions, Claude Desktop extensions. | `enabledPlugins` in `~/.claude/settings.json`; `[plugins."x"]` or `[plugins.'x']` `enabled` in `~/.codex/config.toml`; `isEnabled` in Claude Desktop's extension settings; Gemini extension folders are moved aside. |
| **Config files** | Every settings, instruction and `.env` file the harnesses read, grouped by kind and by harness, including files in Microsoft Store apps' private folders. Click a file to edit it. | Instruction and `.env` files can be switched off, which renames them with a `.skm-disabled` suffix so the harness ignores them. |
| **Env vars** | Every variable in every `.env` file found (home, harness folders, skills) and in the `env` block of `~/.claude/settings.json`. Values that look secret are masked. | Off comments the line out (`# skm-off:`) or moves the key to `envDisabledBySkm`. **Set…** replaces a value without showing the old one. |
| **Harnesses** | Every harness found on this machine, whether it is running, and its launch settings. | **Restart just this harness** / **Start**. |
| **Backups** | Backups of the whole harness configuration, kept in `~/.skill-manager/snapshots`. | **Back up now…**, **Restore…**, **Restore from a file…**, **Copy to folder…** (see below). |
| **Trash** | Uninstalled skills. | Restore puts the folder, lock entry and links back. |

## Backup and restore

**Back up now…** saves one `.hcmbackup` file holding the parts you tick:

- **Skills:** the shared store `~/.agents/skills`, its lock file, and every harness skills folder. Links are saved as links and recreated on restore. `.git`, `node_modules`, `.venv` and `__pycache__` folders are left out, because they can be rebuilt.
- **MCP server configs:** every MCP config file the app knows.
- **Plugin and extension switches:** Claude Code and Codex plugin settings, Gemini extension enablement, Claude Desktop extension settings.
- **Settings and instruction files:** everything in the Config files tab except `.env` files.
- **.env files:** off by default, because they hold secrets.
- **This app's records:** disabled items, the Trash list and launch settings.

A password (at least 8 characters) encrypts the whole backup with AES-256-GCM. Use one whenever you include `.env` files, and bear in mind that MCP configs and settings files can hold API keys too. There is no way to recover a forgotten password. Never commit a backup to a repository.

**Restore…** first compares the backup with this machine and lists every item as changed, missing here or the same. Changed and missing items are ticked; you can untick any. Items that already match are left alone. Everything a restore overwrites or replaces is moved to `~/.skill-manager/trash/<time>-replaced-by-restore/` first, so a restore can be undone. Paths are saved relative to your home folder and app-data folder, so a backup also restores on another machine or OS user. Restart the harnesses afterwards so they load the restored configuration.

You can also drop a `.hcmbackup` file on the window. The browser version uploads backups up to 60 MB; for bigger ones, copy the file into `~/.skill-manager/snapshots` or use the desktop app. **Copy to folder…** copies a backup somewhere else, such as a USB drive.

## .mcpb bundles

Click **Install .mcpb…** or drop a `.mcpb` / `.dxt` file anywhere on the window. The app reads the bundle itself (it is a zip with a `manifest.json`), shows its description, tools, platform support and settings form, and offers two ways to install it:

1. **Open in Claude Desktop**: hands the file to Claude Desktop's own installer.
2. **Install into any harness**: unpacks it to `~/.skill-manager/mcpb/<name>/<version>/` and writes an MCP server entry built from `manifest.server.mcp_config` (with `${__dirname}`, `${user_config.*}`, `${HOME}` and the per-OS `platform_overrides` resolved) into every config you tick, JSON or Codex TOML.

## Checks and "Diagnose with Claude Code"

The editor runs built-in checks as you work, and **Check all files** in the Config files tab runs them over everything. They catch invalid JSON (with line and column), JSONC where strict JSON is expected, empty config files, duplicate TOML tables, YAML tabs, MCP servers whose command is not on `PATH` or points at a missing file, invalid URLs, unresolved `${user_config}` placeholders, Claude Code `settings.json` problems (non-boolean `enabledPlugins`, malformed or conflicting permission rules, hooks and status lines that point at missing files), an oversized `~/.claude.json` and project entries for deleted folders, `SKILL.md` frontmatter problems, oversized instruction files, `@imports` and links to missing files, and `.env` syntax and duplicate keys.

**Diagnose with Claude Code** sends the file to your local `claude` CLI in headless mode and shows its verdict, a numbered list of problems with fixes, and a complete corrected file. Secrets are replaced with `<redacted>` before anything leaves the app. **Load the fix into the editor** puts the real secret values back, and nothing is written until you press **Save**. The quick mode answers from the file alone in under a minute. Tick **Verify paths too** to let Claude Code open referenced files (read-only tools, no MCP servers), which takes a few minutes. You can add your own question, such as "why is my Stop hook not firing?".

## Restarting harnesses

**Restart all coding harnesses** (top bar) and **Restart just this harness** (Harnesses tab, the toolbar when a single harness is picked in the sidebar, and the notice after every change) close the harness and open it again. You see the exact processes first and can untick any of them, including the Claude Code session you may be using to talk to this app.

- The relaunched harness gets a **fresh environment**: the system and user variables as they are now (read from the registry on Windows and from a login shell on macOS and Linux), plus any extra variables you add in its **Launch settings**. That is what makes new env vars, skills, plugins, MCP servers and instruction files take effect.
- **Apps** (Claude Desktop, ChatGPT / Codex app, ChatGPT / Codex app (Beta), ChatGPT Classic, Codex app on macOS, Cursor, VS Code, Windsurf, Kiro, Antigravity, Trae, Zed, LM Studio) are asked to close, forced after a few seconds, and reopened from the same executable. Store apps on Windows reopen through their app ID, and they are listed even when they are not running.
- On Windows the Codex desktop app is the Store app named **ChatGPT** (package `OpenAI.Codex`), so it appears as **ChatGPT / Codex app**. The older chat-only app is **ChatGPT Classic**. Helper processes inside the app (its `codex.exe` app server, MCP servers it starts) count toward the app, not as separate harnesses. Store apps carry a **Store** badge with their package and version.
- `~/.codex` (config, skills, plugins) is shared by the Codex CLI and the ChatGPT / Codex apps, so the other tabs label it **Codex / ChatGPT app**, and **Restart now** after a change there offers whichever of them are running.

### Microsoft Store apps' private folders

When a Store app (or anything it launches) creates a new file under AppData, Windows writes it to `%LOCALAPPDATA%\Packages\<app>\LocalCache\Roaming` or `\Local` instead, and only that app sees it there. For each installed Store harness the app also looks in that folder: ChatGPT Classic's `config.json`, the ChatGPT / Codex app's own plugins (`executor-plugins`), Claude Desktop's `Claude-3p` config, and the Store app's copy of any AppData MCP config it knows (shown as, for example, **Claude Desktop (Store)**).
- **CLIs** (Claude Code, Codex, Gemini CLI, Copilot CLI, opencode, Qwen, Amp, Droid, Crush, Goose) reopen in a new terminal window (Windows Terminal or cmd; Terminal.app; your Linux terminal) running a resume command such as `claude --continue` or `codex resume --last`, in the folder they were running in. Windows does not report a CLI's folder, so set one in **Launch settings** (it defaults to your home folder). Background modes (IDE agents over ACP, daemons, MCP servers, `claude -p` runs) are left alone.

**Stop and start.** The top bar also has **Stop all harnesses** and **Start all harnesses**, and each row on the Harnesses tab has **Stop all instances** and **Start all instances**. Stopping lists the exact processes (untick any, including your Claude Code session), closes them the same graceful-then-forced way as a restart, and remembers what was open: one entry per app, or one per CLI instance with its folder and command (the row shows "N stopped by this app"). Starting reopens exactly that, using the same fresh environment as a restart; with nothing remembered, a row's **Start all instances** opens one instance, while **Start all harnesses** does nothing and says so (it never launches harnesses that this app did not stop). An app that is already running is skipped, and the remembered entry is cleared once its harness has started.

**One instance at a time.** Under each harness row, every running instance (PID, folder, command) has its own **Stop** button, which closes only that one and remembers it. The row's **Start one** opens a single new instance, and each remembered entry has a **Start** button that reopens just that one and removes it from the list.

## Restarting MCP servers

In the MCP servers tab, **Show running processes** finds every live process for each configured server and the harness that owns it (Claude Code, Claude Desktop, ChatGPT / Codex app, VS Code...). Stdio servers are matched by their command line; local HTTP servers by the port they listen on.

- **Restart** (per server, per instance with ↻, or **Restart selected servers** for a selection) ends the server's process tree. Harnesses start a fresh copy on their next tool call or reconnect, so it picks up new env vars and settings. If a harness does not bring it back, the result says so and offers **Restart <harness>**.
- Local HTTP servers that no supervisor restarts are started again by this app with the same command line and a fresh environment. A port served from inside a harness (for example a VS Code extension) is not touched; restart that harness instead.
- **End N orphaned processes** cleans up server processes whose harness has already exited.

## Safety

- The server listens on 127.0.0.1 only and every API call needs a per-launch token. The desktop app opens no port at all: the window talks to the app over Electron IPC, and the app accepts those calls only from its own page.
- Harnesses that the desktop app starts or restarts get a fresh environment without the variables Electron sets for itself.
- Every file is backed up to `~/.skill-manager/backups/<time>/` before it changes, edits are refused if the file changed on disk since you opened it, and only files under your home folder can be read or written.
- Nothing is hard-deleted. To reclaim space, delete folders under `~/.skill-manager/trash` yourself.
- Configs with comments (JSONC) and YAML MCP configs are shown read-only for toggling, but you can still edit them in the editor.

## Test

`node test.js` (or `npm test`) round-trips every operation (skills, MCP, plugins, extensions, `.mcpb` install, file edits, env toggles, checks, redaction, process matching, the shared routes) in throwaway sandbox homes and never touches the real one. It needs only Node.js, not `npm install`.

## License

[MIT](../LICENSE)
