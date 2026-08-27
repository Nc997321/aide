#!/usr/bin/env bash
# 清理 src-tauri/target 的增量缓存与覆盖率产物（可安全删除，不影响 deps 缓存）。
# 用法：
#   bash scripts/clean-build.sh          # 删 cov* + debug/incremental（推荐日常用）
#   bash scripts/clean-build.sh --full   # 额外执行 cargo clean（全清，下次启动需全量重编）
#
# 背景：target/debug/deps 是编译好的依赖 rlib（最贵、保留）；incremental 是增量缓存、
# cov* 是覆盖率独立构建（rust-backend 插件 coverage-verify 产物），删了都无痛。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$ROOT/src-tauri/target"

if [[ "${1:-}" == "--full" ]]; then
  echo "[clean-build] --full: cargo clean（清空全部构建产物，下次启动全量重编）..."
  cargo clean --manifest-path "$ROOT/src-tauri/Cargo.toml"
fi

for path in "$TARGET"/cov* "$TARGET"/debug/incremental; do
  if [[ -d "$path" ]]; then
    echo "[clean-build] 删除 $path"
    rm -rf "$path"
  fi
done

echo "[clean-build] 完成。deps 缓存已保留；下次 tauri dev 只重编被改的 crate。"
