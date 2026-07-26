# Optional Java Navigation Pack

## Decision

Build an optional, official Aide **Java Navigation Pack**. It provides
compiler-resolved Java navigation in Aide's file editor: Go to Definition,
Find Usages, call hierarchy, and type hierarchy.

It is not an LSP integration, an MCP server, a persistent language server, or
a VS Code-style extension marketplace. Aide remains an AI-agent desktop tool;
the Java pack is downloaded only by users who want Java review/navigation
support.

## Goals

- Provide exact Java symbol resolution for supported projects, rather than
  text/name matches.
- Keep Java/JDK/compiler memory and dependencies out of the core application
  unless a user enables the pack.
- Give the Aide file editor a provider-neutral navigation API that can later be
  reused by a small number of other official language packs.
- Be explicit whenever the index is unavailable or incomplete. Never present a
  text match as a compiler-resolved usage.

## Non-goals

- Reproducing IntelliJ IDEA or providing a general Java IDE.
- Any LSP protocol, LSP server, or permanently resident Java process.
- A general third-party plugin platform or public marketplace.
- Arbitrary plugin code running in Aide's frontend.
- Completion, inspection, formatting, refactoring, debugging, or builds.
- Gradle support in the first release.

## Why the existing CodeGraph cannot provide this

The current CodeGraph extracts declarations and bare call names with
Tree-sitter. Its symbol table is keyed by name, so it cannot distinguish method
owners, overloads, imports, inheritance, generic bindings, or exact usages.
The current editor also sends a word rather than the source location that must
be resolved.

CodeGraph remains useful as a lightweight cross-language syntax/text fallback,
but it must be visibly labeled as such. It must not claim that a same-name
result is a Java reference.

## Architecture

```text
Aide File Editor
  -> NavigationProvider host (core Aide)
    -> Java Navigation Pack (optional installation)
      -> on-demand Java compiler worker
        -> JDK Compiler API semantic analysis
      -> durable per-workspace index cache
```

Core Aide owns the editor integration, package lifecycle, installation,
verification, memory policy, and presentation. The pack owns Java project
discovery, classpaths, compiler analysis, and semantic index persistence.

### Core navigation provider interface

The host API must be narrow, versioned, and provider-neutral:

- `status(workspace)` returns `ready`, `indexing`, `incomplete`, `unavailable`,
  or `error`, plus coverage and a human-readable reason.
- `definitionAt(request)` resolves the declaration at a source location.
- `referencesAt(request)` resolves the selected declaration and returns its
  exact usages.
- `callHierarchyAt(request)` returns resolved callers/callees.
- `typeHierarchyAt(request)` returns resolved supertypes/subtypes.
- `refresh(workspace, mode)` starts incremental or full indexing.
- `shutdown(workspace)` drops the worker's in-memory state while preserving its
  durable cache.

Requests identify a location, not merely a word:

```ts
interface NavigationRequest {
  workspaceRoot: string;
  filePath: string;
  documentVersion: number;
  text?: string; // Current unsaved buffer when needed.
  offset: number;
  line: number;
  column: number;
}
```

Results must represent a resolved symbol ID, exact source ranges, display
signature, result role, and index/coverage status. `ambiguous`, `incomplete`,
and `unavailable` are first-class outcomes; they are not errors to be hidden.

### Worker protocol

The Java pack worker communicates with Aide through a small JSON-lines protocol
over stdin/stdout. This is a custom request protocol, not LSP. It exposes only
the navigation-provider operations above and no long-lived editor/server
surface.

## Java Navigation Pack

The pack contains:

- A signed manifest with pack ID, host API version, supported platforms, JDK
  requirement, worker JAR/launcher, and declared resource policy.
- A Java compiler worker built on `JavacTask`, `Trees`, `Elements`, and `Types`.
- Maven project-model and classpath discovery code.
- A versioned durable index format and migrations.
- Compatibility fixtures and diagnostics.

### Semantic model

The compiler worker must generate canonical symbol identities, not use names as
join keys:

- Type: module/package plus binary name.
- Field: owner type, field name, and type.
- Constructor: owner type plus erased parameter types.
- Method: owner type, name, erased parameter types, and return type.
- Local/parameter: compiler-element identity scoped to a source unit when
  needed for in-file navigation.

The index stores:

- Declarations with exact source ranges, kind, symbol ID, and display signature.
- References with exact source ranges, role, and resolved target symbol ID.
- Invocation edges between resolved executable IDs.
- Type edges for extends, implements, overrides, and sealed-type relations.
- Coverage metadata: module, source roots, classpath fingerprint,
  generated-source state, and unresolved diagnostics.

For a dirty editor buffer, the worker uses an overlay `JavaFileObject`. If the
overlay cannot be attributed, it returns `incomplete` rather than silently
using stale or text-based results.

## Project support

### First release: Maven

Support Maven single-module and reactor/multi-module projects. Per module, the
pack discovers:

- Main, test, and generated source roots.
- Java release/source/target settings and compiler flags.
- Dependency and inter-module classpaths.
- Annotation-processor/generated-source state.

Classpath discovery is cached behind a project fingerprint. Refresh it only
when relevant build files or dependency metadata change. A user can explicitly
request a full refresh.

If a module cannot be attributed because of a missing dependency, unsupported
layout, broken source, unavailable JDK, or incomplete generated source, the
pack reports the module and reason. It must not produce a fake exact result.

### Later: Gradle

Gradle is a separate project-model implementation after Maven meets the
acceptance criteria. Kotlin is a separate future pack, not part of Java scope.

## Memory and lifecycle policy

- A disabled pack has no Java process and no Java memory cost.
- Start the worker only for an explicit navigation or indexing request.
- Apply a configurable heap cap; use a conservative initial default such as
  `-Xmx256m`.
- Stop the worker after a short idle timeout (target: 30-60 seconds), on
  workspace switch, on disable, and on Aide exit.
- Persist a compact index in the pack cache; Aide never retains the compiler
  project graph.
- Coalesce file-save events and index changed files in batches.
- Pass only the workspace root, pack cache directory, request data, and JDK/
  build configuration to the worker. Navigation requires no network access.

## Installation and distribution

Do not reuse the Claude Agent SDK plugin marketplace. It installs agent plugins
into the agent runtime and is not an editor-extension host.

Add an **Optional language support** page backed by a curated official catalog:

- Initially expose one package: Java Navigation Pack.
- Download from an official versioned release channel only.
- Verify a signed catalog and package SHA-256/signature before installation.
- Store packs and enablement separately from agent plugins.
- Expose Download, Enable, Disable, Update, Remove, installed version, JDK
  requirement, memory limit, index status, and cache size.
- Make automatic updates opt-in.

This is an official feature-pack manager, not a marketplace and not a public
extension ecosystem.

## Editor behavior

For a Java file when the pack is ready:

- Ctrl/Cmd-click resolves the cursor location.
- One exact target navigates immediately.
- Multiple genuine targets show owner, signature, and location for selection.
- Find Usages groups exact occurrences by file and labels declaration, read,
  write, invocation, and type use where available.
- Call/type hierarchy use a hierarchy view or the existing result surface as an
  initial implementation.
- A visible status differentiates `Ready`, `Indexing`, `Incomplete`,
  `Unavailable`, and `Pack not installed`.

For a Java file without the pack, offer installation and retain CodeGraph/text
results only as explicitly labeled fallback matches. Never auto-jump through an
ambiguous fallback.

## Implementation phases

1. **Navigation host foundation**
   - Define provider protocol/types and location-based editor requests.
   - Add process lifecycle management and status/result UI states.
   - Add a fake provider for integration tests.

2. **Curated feature-pack installer**
   - Implement signed catalog lookup, download, verification, installation,
     enablement, removal, and updates in separate storage.

3. **Java worker MVP**
   - Implement javac-based analysis for a saved single-module Maven project.
   - Support definitions and exact references for types, imports, fields,
     methods, constructors, overloads, inheritance, and overrides.

4. **Maven reactor support**
   - Add multi-module discovery, classpath/source-root resolution, durable
     index cache, incremental rebuilds, cancellation, and coverage diagnostics.

5. **Complete editor integration**
   - Add direct jumps, usages/hierarchy UI, dirty-buffer overlays, status and
     settings controls, memory/idle policy, and fallback labeling.

6. **Hardening and beta**
   - Test framework-heavy projects, generated sources, annotation processors,
     malformed code, unavailable JDKs, large workspaces, and dependencies.

7. **Gradle evaluation**
   - Begin only after the Maven beta satisfies the acceptance criteria.

## Acceptance criteria

The Maven beta is acceptable only when all of these are true:

- Same-name methods from unrelated types never share usage results.
- Overloaded methods resolve and list usages for the correct overload.
- Imported types and static imports resolve correctly.
- Interface methods, overrides, and inherited calls resolve to expected
  declarations.
- Cross-module references resolve when the Maven classpath is complete.
- Dirty-buffer navigation uses the overlay or explicitly reports incomplete.
- Missing dependencies cannot yield a claimed exact usage.
- The worker stops when idle, honors its configured heap cap, and contributes
  no baseline Java memory when the pack is disabled.

