# 清理 src-tauri/target 的增量缓存与覆盖率产物（可安全删除，不影响 deps 缓存）。
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts/clean-build.ps1          # 删 cov* + debug\incremental（推荐日常用）
#   powershell -ExecutionPolicy Bypass -File scripts/clean-build.ps1 -Full   # 额外执行 cargo clean（全清，下次启动需全量重编）
#
# 背景：target\debug\deps 是编译好的依赖 rlib（最贵、保留）；incremental 是增量缓存、
# cov* 是覆盖率独立构建（rust-backend 插件 coverage-verify 产物），删了都无痛。
param(
  [switch]$Full
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Target = Join-Path $Root "src-tauri\target"

if ($Full) {
  Write-Host "[clean-build] -Full: cargo clean（清空全部构建产物，下次启动全量重编）..."
  & cargo clean --manifest-path (Join-Path $Root "src-tauri\Cargo.toml")
}

# 动态找 cov* 目录（将来新增 cov-xxx 也能清到），加 incremental
$Targets = @(Get-ChildItem $Target -Directory -Filter "cov*" -ErrorAction SilentlyContinue)
$Incremental = Join-Path $Target "debug\incremental"
if (Test-Path $Incremental) { $Targets += Get-Item $Incremental }

foreach ($item in $Targets) {
  Write-Host "[clean-build] 删除 $($item.FullName)"
  Remove-Item -Recurse -Force $item.FullName
}

Write-Host "[clean-build] 完成。deps 缓存已保留；下次 tauri dev 只重编被改的 crate。"
