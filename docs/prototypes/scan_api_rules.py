"""Scan aide Rust codebase for rust-api-rules §一 violations.

Heuristic first pass over src-tauri/src/**/*.rs:
  - positional params >= 6
  - adjacent same-typed params (e.g. 2+ Option<String> in a row)
  - 2+ bool params (naked bool wall)
  - Option<bool>
  - &Vec<T> / &String params
  - dead params (let _ = <name>;)
  - fn body > 40 lines

Usage: python scan_api_rules.py <src-dir>
"""
import os
import re
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else "src-tauri/src"

PARAM_RE = re.compile(
    r'(?P<name>[_a-z][_a-zA-Z0-9]*)\s*:\s*'
    r'(?P<type>[^,]+?)\s*(?:,|\)|\n\s*->)'
)

def read_fns(path):
    """Yield (name, start_line, end_line, params, body_text)."""
    with open(path, encoding="utf-8", errors="replace") as f:
        src = f.read()
    lines = src.splitlines()
    # find 'fn <name>(' at column 0-ish (not inside comments/strings - heuristic)
    for m in re.finditer(r'^[ \t]*fn\s+([_a-zA-Z][_a-zA-Z0-9]*)\s*\(', src, re.M):
        start = m.start()
        lno = src.count('\n', 0, start) + 1
        name = m.group(1)
        # skip test fns? no - report them with a flag
        # find matching close paren of signature (depth 1 for ())
        i = m.end()
        depth = 1
        while i < len(src) and depth > 0:
            if src[i] == '(':
                depth += 1
            elif src[i] == ')':
                depth -= 1
            i += 1
        sig_end = i
        sig_text = src[m.end():sig_end]
        # body: find the '{' after sig (next non-ws char, heuristic: skip -> Type {)
        j = sig_end
        while j < len(src) and src[j] not in '{':
            j += 1
        if j >= len(src):
            continue
        depth = 1
        k = j + 1
        while k < len(src) and depth > 0:
            if src[k] == '{':
                depth += 1
            elif src[k] == '}':
                depth -= 1
            k += 1
        body = src[j:k]
        body_lines = body.count('\n') + 1
        params = []
        for pm in PARAM_RE.finditer(sig_text):
            ptype = pm.group('type').strip()
            params.append((pm.group('name'), ptype))
        yield name, lno, lno + body_lines, params, body, lines[lno-1:lno+8]


def classify(name, lno, body_lines, params, body):
    issues = []
    if len(params) >= 6:
        issues.append(f"PARAMS>=6 ({len(params)})")
    # adjacent same types: only flag high-risk pairs (Option<..> or custom/
    # non-primitive types). Bare &str/String/numeric adjacency is usually
    # intentional (from,to) - too noisy.
    PRIMITIVES = {'bool', 'u8', 'i32', 'u32', 'i64', 'u64', 'i16', 'u16',
                  'usize', 'isize', 'f32', 'f64', 'String', 'str', '&str'}
    base = lambda t: (re.sub(r"&'?[a-z_]*\s*", '', t) or t).replace('mut ', '').replace('&', '')
    for i in range(len(params) - 1):
        a, b = params[i][1], params[i+1][1]
        ba, bb = base(a), base(b)
        if ba != bb or ba in PRIMITIVES:
            continue
        if ba.startswith('Option<') or bb.startswith('Option<'):
            issues.append(f"ADJ-SAME ({a} | {b})")
        else:
            issues.append(f"ADJ-SAME-CUSTOM ({a} | {b})")
    bools = [p for p in params if p[1] == 'bool']
    if len(bools) >= 2:
        issues.append(f"BOOL-WALL ({len(bools)})")
    for pname, ptype in params:
        if 'Option<bool>' in ptype:
            issues.append("OPTION-BOOL")
        if re.match(r'&Vec<', ptype):
            issues.append("REF-VEC")
        if ptype.startswith('&String'):
            issues.append("REF-STRING")
        # dead param: 必须是「整个赋值语句的接收者」(紧跟分号/行尾)——
        # `let _ = app.emit(...)` 是忽略返回值不是死参数
        if re.search(rf'\blet _\s*=\s*{pname}\s*;', body) or re.search(rf'\blet _\s*=\s*{pname}\s*$', body, re.M):
            issues.append(f"DEAD-PARAM({pname})")
    if body_lines > 40:
        issues.append(f"BODY>{body_lines}L")
    return issues


def main():
    hits = []
    for root, _, files in os.walk(SRC):
        for fn in files:
            if not fn.endswith('.rs'):
                continue
            path = os.path.join(root, fn)
            if any(seg in path for seg in ('target', 'node_modules')):
                continue
            try:
                for name, lno, end, params, body, ctx in read_fns(path):
                    issues = classify(name, lno, end - lno, params, body)
                    if issues:
                        hits.append((len(issues), lno, path, name, issues, params, ctx))
            except Exception as e:
                print(f"# ERR {path}: {e}", file=sys.stderr)
    hits.sort(key=lambda h: (-h[0], h[1]))
    for n, lno, path, name, issues, params, ctx in hits:
        rel = os.path.relpath(path, SRC)
        plist = ', '.join(f"{p[0]}:{p[1]}" for p in params[:14])
        print(f"[{n}] {rel}:{lno} {name}({plist})")
        print(f"    {'; '.join(issues)}")
        # context lines
        for c in ctx[:4]:
            print(f"    | {c.strip()[:110]}")
    print(f"\nTOTAL: {len(hits)} candidate functions")


if __name__ == '__main__':
    main()
