# Aide

A native desktop client for Claude Code, built on the [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk). Tauri v2 + Vue 3.

> **Disclaimer:** This project is **not affiliated with, endorsed by, or sponsored by Anthropic.**
> "Claude" is a trademark of Anthropic PBC. All trademarks belong to their respective owners.

## What is Aide?

Aide is a standalone desktop client that drives the Claude Agent SDK directly — no Claude Code CLI installation required. Conversations run in a bundled Node.js sidecar, giving you:

- Multi-panel layout with draggable splitters
- Session list backed by Claude Code's real storage (no data lock-in)
- Full chat history browsing across sessions
- Markdown rendering for Claude responses
- File tree with one-click file opening
- Context menus for files, folders, and sessions

Aide bundles the Claude Agent SDK runtime through Anthropic's official distribution. You authenticate with your own provider credentials (Settings → 模型).

## Features

- **Chat with Claude** — streaming via the Claude Agent SDK in a Node.js sidecar, rendered as styled chat bubbles, with an interrupt (stop) button
- **Context compaction feedback** — shows a live, theme-aware status while the agent is compressing context, without inventing a percentage
- **Session management** — reads directly from the aide-managed Claude config dir (`~/.aide/claude/`), in Claude Code's native format, so nothing is locked into a private database
- **File tree** — lazy-loaded directory browser, filtered (skips `.`, `node_modules`, `target`, `dist`)
- **File viewer & editor** — CodeMirror-based editing with syntax highlighting
- **Workspace scanning** — lists all projects you've used Claude with
- **Right-click menus** — context-aware menus on files, directories, sessions, and messages
- **Multiple themes** — glass (default), warm-dark, catppuccin, smoky-pink-glass
- **Session search** — quick search across sessions
- **Git panel** — branch and file status at a glance
- **LSP integration** — go-to-definition and diagnostics for supported languages
- **Plugin marketplace** — browse and install plugins from the marketplace
- **Background tasks (btw)** — run long-running tasks alongside the chat
- **Remote access** — connect from a browser via the remote PWA + relay server
- **Ctrl+N** — quick new session

See [PLANS.md](./PLANS.md) for the product backlog.

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
│   ├── App.vue             # Layout + theme bootstrap
│   ├── components/         # ChatPanel, SidebarLeft, FileTree, GitPanel, ...
│   ├── composables/        # useChatSession, useSettings, useGit, ...
│   ├── themes/             # Theme tokens (glass / warm-dark / catppuccin / smoky-pink-glass)
│   └── ui/                 # Shared UI primitives (AButton, AInput, ...)
├── src-tauri/              # Rust / Tauri backend
│   ├── src/
│   │   ├── lib.rs          # App entry point
│   │   ├── commands/       # Tauri commands (filesystem, git, session, settings, ...)
│   │   ├── remote/         # Remote protocol v2 (relay client + RPC whitelist)
│   │   ├── lsp/            # LSP integration
│   │   ├── codegraph/      # Code graph index
│   │   └── ...             # policy, runtime, diagnostics, skills, ...
│   ├── Cargo.toml
│   └── tauri.conf.json
├── packages/aide-sdk/      # @aide/sdk — shared SDK facade (types, api, transport, useChatSession)
├── agent-sidecar/          # Node.js sidecar — Claude Agent SDK workers
├── remote-pwa/             # Remote PWA client (WebSocket)
├── relay-server/           # Relay server for remote connections
├── package.json
├── vite.config.ts
└── PLANS.md                # Product backlog & architecture notes
```

## How it works

```
User types message
  → Vue forwards it to the agent runtime (sidecar) via Tauri IPC
    → Node.js worker runs Claude Agent SDK query() with streaming input
      → SDK events stream back to the UI
        → Vue appends text to chat bubble (marked renders Markdown)
```

Desktop and remote PWA share the same SDK facade (`@aide/sdk`): a transport abstraction swaps Tauri IPC for WebSocket, so the chat logic is identical in both.

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
