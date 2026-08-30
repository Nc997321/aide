#!/usr/bin/env python3
"""从 llvm-cov 的 lcov 导出中，按函数聚合行/分支覆盖率，输出对账表。

用法: python cov-report.py <lcov文件> [文件名过滤子串] [函数名过滤子串]
输出: 每个函数一行 —— 行覆盖、分支覆盖、未覆盖分支所在行号。

显示名策略：FN 记录自带函数起始行号，直接读源码该行取函数签名，
比反改编符号更可读；读不到源码时回退到 v0 启发式反改编。
"""
import os
import re
import sys
from collections import defaultdict


def demangle(sym):
    """Rust v0 符号启发式解码：确定性解析 <len><ident> 段，用 :: 连接。"""
    if not sym.startswith("_R"):
        return sym
    s = sym[2:]
    parts = []
    i = 0
    while i < len(s):
        if s[i].isdigit():
            j = i
            while j < len(s) and s[j].isdigit():
                j += 1
            n = int(s[i:j])
            if 0 < n <= 64 and j + n <= len(s):
                name = s[j:j + n]
                if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
                    parts.append(name)
                    i = j + n
                    continue
            i = j
        else:
            i += 1
    return "::".join(parts[-4:]) if parts else sym


def parse(path):
    files = {}
    cur = None
    for raw in open(path, encoding="utf-8", errors="replace"):
        line = raw.strip()
        if line.startswith("SF:"):
            cur = {"fn": [], "fnda": {}, "brda": [], "da": {}}
            files[line[3:]] = cur
        elif line.startswith("FN:") and cur is not None:
            ln, name = line[3:].split(",", 1)
            cur["fn"].append((int(ln), name))
        elif line.startswith("FNDA:") and cur is not None:
            hits, name = line[5:].split(",", 1)
            cur["fnda"][name] = int(hits)
        elif line.startswith("BRDA:") and cur is not None:
            ln, block, br, taken = line[5:].split(",")
            cur["brda"].append((int(ln), int(block), int(br), taken))
        elif line.startswith("DA:") and cur is not None:
            parts = line[3:].split(",")
            cur["da"][int(parts[0])] = int(parts[1])
        elif line == "end_of_record":
            cur = None
    return files


_src_cache = {}


def source_line(path, ln):
    """读源文件第 ln 行（1-based），失败返回 None。带缓存。"""
    if path not in _src_cache:
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                _src_cache[path] = f.readlines()
        except OSError:
            _src_cache[path] = None
    lines = _src_cache[path]
    if not lines or ln > len(lines):
        return None
    text = lines[ln - 1].strip()
    return text or None


def display_name(fname, ln, sym):
    text = source_line(fname, ln)
    if text and ("fn " in text or "impl" in text or "match" in text or text.startswith("}")):
        return text
    return demangle(sym)


def main():
    if len(sys.argv) < 2:
        sys.exit("用法: cov-report.py <lcov文件> [文件名过滤子串] [函数名过滤子串]")
    path = sys.argv[1]
    file_filter = sys.argv[2] if len(sys.argv) > 2 else None
    fn_filter = sys.argv[3] if len(sys.argv) > 3 else None
    files = parse(path)
    for fname, data in files.items():
        if file_filter and file_filter not in fname.replace("\\", "/"):
            continue
        # 函数边界：按 FN 行号排序，函数区间 = [start, next_start-1]
        fns = sorted(data["fn"], key=lambda t: t[0])
        ranges = []
        for i, (ln, name) in enumerate(fns):
            end = fns[i + 1][0] - 1 if i + 1 < len(fns) else 10**9
            ranges.append((ln, end, name))
        print(f"\n== {fname}")
        print(f"{'函数':<58} {'执行':>4} {'行覆盖':>10} {'分支':>8} {'未覆盖分支行'}")
        for start, end, name in ranges:
            hits = data["fnda"].get(name, 0)
            brs = [b for b in data["brda"] if start <= b[0] <= end]
            if not brs:
                continue  # 无分支函数不进对账表
            disp = display_name(fname, start, name)
            if fn_filter and fn_filter not in disp and fn_filter not in name:
                continue
            lines_in = [l for l in data["da"] if start <= l <= end]
            lh = sum(1 for l in lines_in if data["da"][l] > 0)
            lp = f"{lh}/{len(lines_in)}" if lines_in else "-"
            taken = [b for b in brs if b[3] not in ("-", "0")]
            miss = sorted({b[0] for b in brs if b[3] in ("-", "0")})
            miss_s = ",".join(str(m) for m in miss[:8]) + ("…" if len(miss) > 8 else "")
            print(f"{disp[:58]:<58} {hits:>4} {lp:>10} {len(taken)}/{len(brs):>6} {miss_s}")


if __name__ == "__main__":
    main()
