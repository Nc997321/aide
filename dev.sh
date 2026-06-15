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
echo "Starting Tauri dev server..."
echo ""

pnpm tauri dev
