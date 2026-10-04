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
- **Multiple themes** — glass (default), warm-dark, smoky-pink-glass
- **Session search** — quick search across sessions
- **Git panel** — branch and file status at a glance
- **LSP integration** — go-to-definition and diagnostics for supported languages
- **Plugin marketplace** — browse and install plugins from the marketplace
- **Background tasks (btw)** — run long-running tasks alongside the chat
- **Hosts: local / WSL / SSH** — one window = one Host. The whole backend (sessions, agent, files, git, terminal, LSP, plugins, memory, providers) runs on the Host; remote Hosts are persistent daemons, so sessions survive disconnects. See [docs/host-model.md](docs/host-model.md)
- **Built-in browser** — embedded browser panel the agent can drive through a built-in MCP server
- **Knowledge base** — team knowledge base ([knowledge-server/](knowledge-server/)) in the sidebar; select a passage in a document to let the agent edit just that range
- **Automation** — scheduled / repeatable agent tasks
- **Workbench terminal** — integrated terminal
- **Mobile remote (Aide Link)** — pair a phone by scanning a QR code; traffic is end-to-end encrypted (Noise) through a relay that only bridges bytes. One paired device at a time. Protocol: [docs/aide-link-protocol.md](docs/aide-link-protocol.md)
- **Ctrl+N** — quick new session

## Prerequisites

- Your own Claude provider credentials, configured in the app (Settings → 模型)
- **Rust** 1.96+ (MSVC toolchain on Windows)
- **VS Build Tools 2022** (for `link.exe` on Windows)
- **Node.js** 24+
- **pnpm** 11+
- **Windows SDK** 10.0.26100+

Windows is the primary platform. macOS builds are checked by CI (`cargo check` + tests); Linux should work but is less exercised.

## Quick start

```bash
# Clone
git clone https://github.com/<your-username>/aide.git
cd aide

# Install dependencies (the sidecar is intentionally outside the pnpm workspace)
pnpm install
pnpm --dir agent-sidecar install

# Launch in dev mode (builds the sidecar first)
pnpm tauri dev
```

## Build

```bash
# Full release: sidecar binary + remote kit (aide-host static binary) + Tauri bundle
pnpm release
```

## Project structure

```
aide/
├── src/                    # Vue 3 frontend
│   ├── App.vue             # Layout + theme bootstrap
│   ├── components/         # ChatPanel, SidebarLeft, FileTree, GitPanel, Browser, KnowledgeBase, ...
│   ├── composables/        # useSettings, useGit, ...
│   ├── themes/             # Theme tokens (glass / warm-dark / smoky-pink-glass)
│   └── ui/                 # Shared UI primitives (AButton, AInput, ...)
├── src-tauri/              # Tauri shell (GUI front door)
│   ├── src/
│   │   ├── lib.rs          # App entry point
│   │   ├── host_door.rs    # Dispatches commands to the local Host in-process or forwards to a remote Host
│   │   ├── host_window.rs  # Window ↔ Host binding
│   │   └── ...             # browser, runtime, diagnostics, ...
│   ├── crates/
│   │   ├── aide-core/      # The command table + Host state (sessions, fs, git, LSP, providers, ...); no Tauri dependency
│   │   ├── aide-host/      # `aide-host serve` — headless Host daemon for WSL / SSH
│   │   ├── aide-link/      # Aide Link phone protocol (QR pairing, Noise E2E, exposed command catalog)
│   │   └── aide-workspace/ # Workspace operations (fs / search / git), shared by desktop and aide-host
│   └── tauri.conf.json
├── packages/aide-sdk/      # @aide/sdk — shared SDK facade (types, api, transport, useChatSession)
├── agent-sidecar/          # Node.js sidecar — Claude Agent SDK workers (engine / extensions / desktop)
├── remote-pwa/             # Mobile web client
├── ohos/                   # HarmonyOS client (ArkTS, outside the pnpm workspace)
├── relay-server/           # Dumb relay for Aide Link
├── knowledge-server/       # Team knowledge base service (Rust)
└── docs/                   # Architecture & protocol docs
```

## How it works

```
User types message
  → Vue calls the @aide/sdk api facade → Tauri IPC
    → host_door runs the command on the window's Host (in-process for local, forwarded for WSL / SSH)
      → aide-core hands it to the Node.js sidecar, which runs Claude Agent SDK query() with streaming input
        → SDK events are broadcast on the Host's event bus to every connected client
          → Vue renders the chat (marked renders Markdown)
```

Desktop and mobile clients share the same SDK facade (`@aide/sdk`): a transport abstraction swaps Tauri IPC for Aide Link, so the chat logic is identical. UI state follows the broadcast event stream, so all clients attached to a session stay in sync.

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
