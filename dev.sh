#!/bin/bash
# Claude Code Desktop - Development Launch Script (Git Bash)
# Sets up MSVC environment and launches Tauri dev mode

export PATH="$HOME/.cargo/bin:$PATH"

MSVC_BASE="C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC"
MSVC_VER=$(ls "$MSVC_BASE" 2>/dev/null | head -1)
MSVC_BIN="$MSVC_BASE/$MSVC_VER/bin/Hostx64/x64"

SDK_BASE="C:/Program Files (x86)/Windows Kits/10"
SDK_VER="10.0.26100.0"
SDK_LIB="$SDK_BASE/Lib/$SDK_VER"
SDK_INCLUDE="$SDK_BASE/Include/$SDK_VER"

export PATH="$MSVC_BIN:$PATH"
export LIB="$SDK_LIB/um/x64;$SDK_LIB/ucrt/x64"
export INCLUDE="$SDK_INCLUDE/ucrt;$SDK_INCLUDE/um;$SDK_INCLUDE/shared"

echo "=== Claude Code Desktop ==="
echo "MSVC: $MSVC_BIN"
echo "SDK:  $SDK_VER"

# ── agent-sidecar 构建 ──
pushd "$(dirname "$0")/agent-sidecar" > /dev/null
if [ ! -d node_modules ]; then
  echo "[aide] 安装 agent-sidecar 依赖..."
  npm install || { echo "[aide] npm install 失败——如果是网络问题请开启代理后重试"; popd > /dev/null; exit 1; }
fi
npm run build || { echo "[aide] sidecar 构建失败"; popd > /dev/null; exit 1; }
popd > /dev/null

echo "Starting Tauri dev server..."
echo ""

pnpm tauri dev
