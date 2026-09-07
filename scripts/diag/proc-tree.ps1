# 诊断用：列出 aide 相关进程树及内存（WS / Private MB）+ 命令行（识别 webview2 归属）
$names = 'aide','msedgewebview2','aide-agent','claude','node','bun'
$procs = Get-Process -Name $names -ErrorAction SilentlyContinue
if (-not $procs) { Write-Output 'NO-PROCESSES'; exit }

# 建立全量 CIM 快照（一次取回，避免逐 pid 查询太慢）
$cim = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine
$cimById = @{}
foreach ($p in $cim) { $cimById[[uint32]$p.ProcessId] = $p }

foreach ($p in ($procs | Sort-Object ProcessName, Id)) {
  $info = $cimById[[uint32]$p.Id]
  $parent = if ($info) { $info.ParentProcessId } else { '?' }
  $cmd = if ($info) { $info.CommandLine } else { '' }
  if ($cmd -and $cmd.Length -gt 140) { $cmd = $cmd.Substring(0, 140) }
  '{0,-16} pid={1,-7} ppid={2,-7} WS={3,8:N0}MB Priv={4,8:N0}MB  {5}' -f `
    $p.ProcessName, $p.Id, $parent, ($p.WorkingSet64/1MB), ($p.PrivateMemorySize64/1MB), $cmd
}