# 启动 relay（哑管道）。
# cwd 固定在本目录：日志落 relay-server/ 下（从仓库根直接起 exe 会丢到仓库根）。
# 默认回环绑定（与 ~/.aide/remote/start-remote.vbs 一致）：nginx 是唯一对外入口。
# 构建：cargo build --release --manifest-path relay-server/Cargo.toml
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not $env:RELAY_ADDR) { $env:RELAY_ADDR = '127.0.0.1:8787' }
$exe = Join-Path $PSScriptRoot 'target\release\aide-relay.exe'
if (-not (Test-Path $exe)) {
    throw "未找到 $exe，先跑：cargo build --release --manifest-path relay-server/Cargo.toml"
}
Start-Process -FilePath $exe -WorkingDirectory $PSScriptRoot -NoNewWindow -Wait `
    -RedirectStandardOutput (Join-Path $PSScriptRoot 'relay.out.log') `
    -RedirectStandardError (Join-Path $PSScriptRoot 'relay.err.log')
