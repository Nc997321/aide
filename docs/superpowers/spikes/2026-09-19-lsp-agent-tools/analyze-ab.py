#!/usr/bin/env python3
"""Score one arm of the LSP hint A/B from its stream-json transcript.

Usage:  python analyze-ab.py ab-control.jsonl [ab-hint.jsonl ...]

Reports, per arm: LSP calls by operation, workspaceSymbol calls that omit
line/character (the shape the tool rejects outright), Grep count, and the
outcome of every LSP call so an empty-because-cold result is visible.
"""

import json
import sys


def load(path):
    uses, results = {}, []
    for line in open(path, encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        content = (obj.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use":
                uses[block["id"]] = {"name": block.get("name"), "input": block.get("input") or {}}
            elif block.get("type") == "tool_result":
                text = block.get("content")
                if isinstance(text, list):
                    text = " ".join(b.get("text", "") for b in text if isinstance(b, dict))
                results.append((block.get("tool_use_id"), str(text)))
    return uses, dict(results)


def outcome(text):
    """One-word verdict for an LSP result, so cold-window emptiness is visible."""
    low = text.lower()
    # Match real failure markers only — a naive "error" substring fires on
    # symbol names like `EnsureError` and turns a good result into a false alarm.
    if "tool_use_error" in low or "error performing" in low or "unsafe location" in low:
        return "ERROR"
    if not text.strip():
        return "EMPTY?"
    if "no references found" in low or "no symbols found" in low or "no definition found" in low:
        return "EMPTY"
    return "OK"


def report(path):
    uses, results = load(path)
    calls = [(u["name"], u["input"], results.get(tid, "")) for tid, u in uses.items()]
    lsp = [(i, r) for n, i, r in calls if n == "LSP"]
    grep = [i for n, i, _ in calls if n == "Grep"]
    missing = [i for i, _ in lsp if not i.get("line") or not i.get("character")]

    print(f"\n===== {path} =====")
    print(f"  LSP 调用        : {len(lsp)}")
    print(f"  Grep 调用       : {len(grep)}")
    print(f"  ! workspaceSymbol 缺 line/character : {len(missing)}")
    for i, r in lsp:
        print(f"    - {i.get('operation'):<18} {outcome(r):<7} {str(i.get('query',''))[:24]:<26} {r[:90].replace(chr(10),' ')}")


if __name__ == "__main__":
    for p in sys.argv[1:]:
        report(p)
