#!/usr/bin/env bash
# 启动 relay（哑管道）。
# cwd 固定在本目录：日志落 relay-server/ 下。从仓库根直接起 exe 会把
# relay.err.log 丢到仓库根（2026-09-12 丢帧日志事故的现场）。
# 默认回环绑定（与 ~/.aide/remote/start-remote.vbs 一致）：nginx 是唯一对外入口。
# 构建：cargo build --release --manifest-path relay-server/Cargo.toml
set -euo pipefail
cd "$(dirname "$0")"
export RELAY_ADDR="${RELAY_ADDR:-127.0.0.1:8787}"
bin=./target/release/aide-relay
if [ -x "$bin.exe" ]; then
  bin="$bin.exe" # Windows(MSVC) 产物带 .exe
fi
if [ ! -x "$bin" ]; then
  echo "未找到 $bin，先跑：cargo build --release --manifest-path relay-server/Cargo.toml" >&2
  exit 1
fi
exec "$bin" > relay.out.log 2> relay.err.log
