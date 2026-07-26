# Aide

Unofficial desktop interface for Claude Code CLI. Built with Tauri v2 + Vue 3.

> **Disclaimer:** This project is **not affiliated with, endorsed by, or sponsored by Anthropic.**
> "Claude" is a trademark of Anthropic PBC. This is an independent open-source wrapper
> that requires a separate installation of the official Claude Code CLI.
> All trademarks belong to their respective owners.

## What is Aide?

Aide wraps the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) in a desktop GUI, giving you:

- Multi-panel layout with draggable splitters
- Session list backed by Claude Code's real storage (no data lock-in)
- Full chat history browsing across sessions
- Markdown rendering for Claude responses
- File tree with one-click file opening
- Context menus for files, folders, and sessions

Aide does **not** bundle or redistribute the Claude Code CLI. It is a UI layer only — you must install `claude` yourself.

## Features

- **Chat with Claude** — `claude -p --resume <sessionId>` under the hood, rendered as styled chat bubbles
- **Context compaction feedback** — shows a live, theme-aware status while the agent is compressing context, without inventing a percentage
- **Session management** — reads directly from `~/.claude/projects/` and `~/.claude/sessions/`, so your conversations stay in sync with the CLI
- **File tree** — lazy-loaded directory browser, filtered (skips `.`, `node_modules`, `target`, `dist`)
- **Workspace scanning** — lists all projects you've used Claude with
- **Right-click menus** — context-aware menus on files, directories, sessions, and messages
- **Dark theme** — Catppuccin-inspired color scheme
- **Ctrl+N** — quick new session

### Work in progress

- Streaming output (currently `claude -p` returns all at once)
- Code syntax highlighting
- Stop button for in-progress responses
- Workspace switcher UI
- Session search

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/overview) installed and authenticated
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
├── package.json
├── vite.config.ts
└── PLANS.md                # Product backlog & architecture notes
```

## How it works

```
User types message
  → Vue invokes chat_send(message, sessionId)
    → Rust spawns "claude -p <msg> --resume <sessionId>"
      → stdout parsed and emitted as chat-chunk events
        → Vue appends text to chat bubble (marked.js renders Markdown)
```

Session data lives in `~/.claude/` (Claude Code's own storage). Aide never duplicates your conversations — it reads and displays what Claude already stores.

## License

MIT — see [LICENSE](./LICENSE) for details.

## Disclaimer

- Aide is an independent project. It is **not** created by, endorsed by, or affiliated with Anthropic.
- "Claude" is a trademark of Anthropic PBC. Use of the name is purely descriptive.
- This tool does not bundle, modify, or redistribute the Claude Code CLI. Users must install and authenticate the CLI separately.
- The authors assume no liability for use of this software. Use at your own risk.
