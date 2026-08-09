# Aide

Unofficial desktop interface for Claude Code, built on the [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk). Tauri v2 + Vue 3.

> **Disclaimer:** This project is **not affiliated with, endorsed by, or sponsored by Anthropic.**
> "Claude" is a trademark of Anthropic PBC. All trademarks belong to their respective owners.

## What is Aide?

Aide gives [Claude Code](https://docs.anthropic.com/en/docs/claude-code) a desktop GUI. Conversations are driven by the Claude Agent SDK `query()` in a bundled Node.js sidecar (no terminal wrapper), giving you:

- Multi-panel layout with draggable splitters
- Session list backed by Claude Code's real storage (no data lock-in)
- Full chat history browsing across sessions
- Markdown rendering for Claude responses
- File tree with one-click file opening
- Context menus for files, folders, and sessions

Aide ships the Claude Code runtime through Anthropic's official Claude Agent SDK distribution — no separate CLI installation is required. You authenticate with your own provider credentials (Settings → 模型).

## Features

- **Chat with Claude** — streaming via the Claude Agent SDK in a Node.js sidecar, rendered as styled chat bubbles
- **Context compaction feedback** — shows a live, theme-aware status while the agent is compressing context, without inventing a percentage
- **Session management** — reads directly from the aide-managed Claude config dir (`~/.aide/claude/`), in Claude Code's native format, so nothing is locked into a private database
- **File tree** — lazy-loaded directory browser, filtered (skips `.`, `node_modules`, `target`, `dist`)
- **Workspace scanning** — lists all projects you've used Claude with
- **Right-click menus** — context-aware menus on files, directories, sessions, and messages
- **Dark theme** — Catppuccin-inspired color scheme
- **Ctrl+N** — quick new session

### Work in progress

- Code syntax highlighting
- Stop button for in-progress responses
- Workspace switcher UI
- Session search

## Prerequisites

- Your own Claude provider credentials, configured in the app (Settings → 模型)
- **Rust** 1.96+ (MSVC toolchain on Windows)
- **VS Build Tools 2022** (for `link.exe` on Windows)
- **Node.js** 24+
- **pnpm** 11+
- **Windows SDK** 10.0.26100+

macOS and Linux should work but have not been tested.

## Quick start

```bash
# Clone
git clone https://github.com/<your-username>/aide.git
cd aide

# Install dependencies
pnpm install

# Launch in dev mode
# Windows (PowerShell):
.\dev.ps1
# Git Bash / Linux / macOS:
./dev.sh
```

The dev scripts handle MSVC environment setup on Windows. On other platforms, `pnpm tauri dev` should work if Rust is installed.

## Build

```bash
pnpm tauri build
```

## Project structure

```
aide/
├── src/                    # Vue 3 frontend
│   ├── App.vue             # Three-panel layout + drag splitters
│   ├── components/         # ChatPanel, SidebarLeft, FileTree, ContextMenu, TreeNodeItem
│   ├── composables/        # useContextMenu state layer
│   ├── menus/              # Context menu configuration
│   └── styles/             # Dark theme CSS
├── src-tauri/              # Rust / Tauri backend
│   ├── src/
│   │   ├── lib.rs          # App entry point
│   │   ├── commands.rs     # 17 Tauri commands
│   │   └── pty.rs          # PTY support
│   ├── Cargo.toml
│   └── tauri.conf.json
├── agent-sidecar/          # Node.js sidecar — Claude Agent SDK query() workers
├── package.json
├── vite.config.ts
└── PLANS.md                # Product backlog & architecture notes
```

## How it works

```
User types message
  → Vue forwards it to the agent runtime (sidecar)
    → Node.js worker runs Claude Agent SDK query() with streaming input
      → SDK events stream back to the UI
        → Vue appends text to chat bubble (marked renders Markdown)
```

Session data lives in `~/.aide/claude/` (aide-managed `CLAUDE_CONFIG_DIR`), in Claude Code's native storage format. Aide never duplicates your conversations into a private database — it reads and displays what the runtime already stores.

## Settings & permissions

Aide keeps its own layered settings (`~/.aide/settings.json` + per-project `.aide/settings.json` / `.aide/settings.local.json` + a read-only managed-policy layer) and stores credentials in the OS keychain — it does **not** read or write Claude Code's `.claude/settings.json` permission rules. Tool permissions (`allow | ask | deny`) are managed from **设置 → 权限** in the app. Precedence rules, file locations, secret handling, and the manual acceptance matrix are in [docs/testing/permission-settings-manual-acceptance.md](docs/testing/permission-settings-manual-acceptance.md); the architecture boundary is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

MIT — see [LICENSE](./LICENSE) for details.

## Disclaimer

- Aide is an independent project. It is **not** created by, endorsed by, or affiliated with Anthropic.
- "Claude" is a trademark of Anthropic PBC. Use of the name is purely descriptive.
- The Claude Code runtime included with Aide comes from Anthropic's official Claude Agent SDK packages and is subject to [Anthropic's legal agreements](https://code.claude.com/docs/en/legal-and-compliance). Using it requires your own valid Claude credentials.
- The authors assume no liability for use of this software. Use at your own risk.
