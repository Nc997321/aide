#!/usr/bin/env python3
"""多 object 的 lcov 文本级合并。

背景：llvm-cov export 一次传多个 object 时，同名函数在不同 object 的
coverage mapping hash 不同，以第一个 object 为准会丢弃后续 object 的数据。
正确做法是每个 object 单独导 lcov，再在文本层合并。

用法: python merge-lcov.py <out.lcov> <in1.lcov> <in2.lcov> ...
规则: DA/FNDA/BRDA 计数求和；BRDA 的 "-" 当 0，合并后仍全为 "-" 则保持 "-"；
      FN 记录取首次出现（去重）。
"""
import sys
from collections import defaultdict


def _new_file():
    return {"da": defaultdict(int), "fn": [], "fnda": defaultdict(int),
            "brda": defaultdict(lambda: [0, False])}


def load(path):
    files = {}
    cur = None
    for raw in open(path, encoding="utf-8", errors="replace"):
        line = raw.strip()
        if line.startswith("SF:"):
            cur = files.setdefault(line[3:], _new_file())
        elif line.startswith("DA:") and cur is not None:
            parts = line[3:].split(",")
            cur["da"][int(parts[0])] += int(parts[1])
        elif line.startswith("FN:") and cur is not None:
            ln, name = line[3:].split(",", 1)
            cur["fn"].append((int(ln), name))
        elif line.startswith("FNDA:") and cur is not None:
            hits, name = line[5:].split(",", 1)
            cur["fnda"][name] += int(hits)
        elif line.startswith("BRDA:") and cur is not None:
            ln, block, br, taken = line[5:].split(",")
            slot = cur["brda"][(int(ln), int(block), int(br))]
            if taken != "-":
                slot[0] += int(taken)
                slot[1] = True
        elif line == "end_of_record":
            cur = None
    return files


def main():
    out_path, inputs = sys.argv[1], sys.argv[2:]
    if not inputs:
        sys.exit("用法: merge-lcov.py <out.lcov> <in1.lcov> ...")
    merged = {}
    for p in inputs:
        for sf, data in load(p).items():
            tgt = merged.setdefault(sf, _new_file())
            for ln, cnt in data["da"].items():
                tgt["da"][ln] += cnt
            seen = set(tgt["fn"])
            tgt["fn"].extend(t for t in data["fn"] if t not in seen)
            for name, hits in data["fnda"].items():
                tgt["fnda"][name] += hits
            for key, (cnt, any_num) in data["brda"].items():
                slot = tgt["brda"][key]
                slot[0] += cnt
                if any_num:
                    slot[1] = True
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write("TN:\n")
        for sf in sorted(merged):
            data = merged[sf]
            f.write(f"SF:{sf}\n")
            for ln in sorted(data["da"]):
                f.write(f"DA:{ln},{data['da'][ln]}\n")
            for ln, name in data["fn"]:
                f.write(f"FN:{ln},{name}\n")
            for name, hits in sorted(data["fnda"].items(), key=lambda t: -t[1]):
                f.write(f"FNDA:{hits},{name}\n")
            for key in sorted(data["brda"]):
                cnt, any_num = data["brda"][key]
                f.write(f"BRDA:{key[0]},{key[1]},{key[2]},{cnt if any_num else '-'}\n")
            f.write("end_of_record\n")
    print(f"merged {len(inputs)} lcov -> {out_path} ({len(merged)} source files)")


if __name__ == "__main__":
    main()
