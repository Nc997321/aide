#!/usr/bin/env bash
# A/B: does Aide's injected LSP hint change the agent's tool choice?
#
#   control = no hint appended
#   hint    = same task, same model, same plugins, + --append-system-prompt-file
#
# Measured from the stream-json transcript:
#   - LSP tool calls, split by operation
#   - workspaceSymbol calls that OMIT line/character  (the rejectable shape —
#     historical evidence shows the model does this unprompted)
#   - Grep call count
#   - whether any references query came back empty and what happened next
#
# Usage:  ./run-lsp-ab.sh control|hint
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
CLI="C:/Users/<user>/AppData/Local/Aide/agent-runtime/claude.exe"
REPO="C:/Users/<user>/IdeaProjects/aide"
PLUGIN_ROOT="C:/Users/<user>/.aide/claude/plugins/cache/claude-plugins-official"

TASK="在 $REPO 里找出函数 is_excluded 的所有调用点（只算真正调用它的地方，不算定义本身、不算注释或字符串里的提及）。只报告 文件:行号，不要修改任何文件。"

arm="${1:?usage: run-lsp-ab.sh control|hint [run-id]}"
runId="${2:-$arm}"
out="$HERE/ab-$runId.jsonl"
: > "$out"

args=(
  -p "$TASK"
  --output-format stream-json --verbose
  --permission-mode bypassPermissions --allow-dangerously-skip-permissions
  --plugin-dir "$PLUGIN_ROOT/rust-analyzer-lsp/1.0.0"
  --plugin-dir "$PLUGIN_ROOT/typescript-lsp/1.0.0"
)
if [ "$arm" = "hint" ]; then
  args+=(--append-system-prompt-file "$HERE/hint.txt")
fi

# Strip the parent session's nesting markers — otherwise the child CLI believes
# it is a sub-session of this one and behaves accordingly (see the repo memory
# on probe env contamination).
env -u CLAUDECODE \
    -u CLAUDE_CODE_ENTRYPOINT \
    -u CLAUDE_CODE_CHILD_SESSION \
    -u CLAUDE_CODE_SESSION_ID \
    -u CLAUDE_PID \
    -u CLAUDE_CODE_MESSAGING_SOCKET \
    -u CLAUDE_CODE_MESSAGING_TOKEN \
    -u CLAUDE_AGENT_SDK_VERSION \
  "$CLI" "${args[@]}" > "$out" 2> "$HERE/ab-$arm.err"
echo "exit=$? → $out ($(wc -l < "$out") 行)"
