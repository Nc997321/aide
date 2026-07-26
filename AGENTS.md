# Aide contributor guide

## Project overview

Aide is a Tauri v2 desktop application with a Vue 3 + TypeScript frontend,
a Rust backend, and a Node.js agent sidecar. It provides a desktop interface
for AI coding agents.

Key directories:

- `src/`: Vue UI, composables, shared TypeScript types, themes, and tests.
- `src-tauri/`: Rust commands, runtime integration, diagnostics, and Tauri
  configuration.
- `agent-sidecar/`: provider-specific agent runtime and its IPC types.
- `docs/`: architecture and product/design documentation.

## Commands

- `pnpm test`: run the frontend test suite.
- `pnpm build`: type-check the frontend and create a production web build.
- `pnpm tauri dev`: run the desktop application when the Rust/MSVC environment
  is already configured. Prefer `./dev.ps1` on Windows and `./dev.sh` on
  Unix-like systems for local development.
- `pnpm tauri build`: build the desktop application.
- `pnpm build:sidecar`: build the Node sidecar and its Windows executable.

Run the narrowest relevant test first. Do not run a desktop build for a
frontend-only change unless it is needed for verification.

## Architecture rules

- Keep the Vue and Rust layers provider-agnostic. Their contract is the shared
  chat/IPC event model; provider-specific behavior belongs in `agent-sidecar/`
  or a provider strategy implementation.
- When evolving IPC, use fields that all providers can support. Put
  provider-specific data in explicit extension fields rather than the core
  protocol.
- Keep paths cross-platform: use `path.join` in TypeScript and `PathBuf` in
  Rust. Do not hard-code Windows path separators.
- Every Windows-spawned external process must use `CREATE_NO_WINDOW`
  (`0x08000000`) behind `#[cfg(windows)]`.
- Paths returned by Tauri `resource_dir()` may carry a Windows verbatim-path
  prefix. Simplify them with `dunce::simplified()` before passing them to an
  external process.
- Tauri commands that perform significant file I/O, CPU work, serialization,
  or child-process work must be asynchronous and offload blocking work with
  `spawn_blocking`. Do not block the Tauri main thread.
- If a synchronous Rust command remains capable of I/O or external execution,
  add `diagnostics::trace_command()` before that work. Do not add it to async
  commands or trivial in-memory operations.

## Frontend conventions

- Use Vue Composition API and TypeScript. Keep stateful behavior in
  composables; keep components focused on rendering and interaction.
- Theme all visual tokens through `src/themes/` and `var(--aide-*)`. Do not add
  hard-coded colors, spacing, radii, or shadows to components. Add a token to
  every theme when a new semantic value is needed.
- For CodeMirror, configure `EditorView.theme(..., { dark: true })` for dark
  themes and verify CodeMirror selector names from its installed source rather
  than guessing them.
- Preserve chat performance: stream deltas through the sidecar coalescer,
  cache settled Markdown, throttle scrolling with `requestAnimationFrame`, and
  render message lists through the message windowing composable.
- Keep chat auto-scroll driven by the existing `ResizeObserver` mechanism;
  do not add data-watchers merely to force scrolling.

## Agent sidecar and user data

- The sidecar is responsible for Claude-specific SDK behavior. Its shared type
  declarations must stay aligned with the frontend chat types.
- Aide's Claude configuration lives under `~/.aide/claude/`, not
  `~/.claude/`. Do not change the latter when implementing Aide configuration.
- On Windows, preserve the `winBashEnv` UTF-8 setup; it makes non-interactive
  Bash output reliable.

## Change hygiene

- Read the nearest relevant code and tests before changing behavior. Existing
  uncommitted changes belong to the user; do not revert or overwrite them.
- Add or update focused tests for logic changes. Keep test names descriptive.
- Use `pnpm test` for frontend logic and `cargo check`/targeted Rust tests for
  backend changes when available.
- Review `git diff` before handing off. Report verification performed and any
  tests that could not be run.

## Further reading

`CLAUDE.md` contains detailed, historical constraints. Consult it before
touching diagnostics, themes, CodeMirror, chat rendering, Windows process
launching, or the agent runtime. See `docs/ARCHITECTURE.md` for the broader
system design.
