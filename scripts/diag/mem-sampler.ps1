# 内存采样器：300ms 间隔记录 aide 全家进程 WS/Private（MB）到 CSV
# 停止：创建 stop 文件 scripts/diag/sampler.stop，或满 40 分钟自动停
$ErrorActionPreference = 'SilentlyContinue'
$csv = "C:/document/owner/cypress-agent/scripts/diag/mem-samples.csv"
$stopFlag = "C:/document/owner/cypress-agent/scripts/diag/sampler.stop"
Remove-Item $csv, $stopFlag -ErrorAction SilentlyContinue
"t,name,pid,wsMB,privMB" | Out-File -FilePath $csv -Encoding utf8

$deadline = (Get-Date).AddMinutes(40)
while ((Get-Date) -lt $deadline -and -not (Test-Path $stopFlag)) {
  $now = Get-Date -Format 'HH:mm:ss.fff'
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($p in (Get-Process -Name 'aide','msedgewebview2','aide-agent','claude','bun' -ErrorAction SilentlyContinue)) {
    $lines.Add("$now,$($p.ProcessName),$($p.Id),$([math]::Round($p.WorkingSet64/1MB,1)),$([math]::Round($p.PrivateMemorySize64/1MB,1))")
  }
  if ($lines.Count -gt 0) { $lines | Out-File -FilePath $csv -Append -Encoding utf8 }
  Start-Sleep -Milliseconds 300
}
"DONE" | Out-File -FilePath "$csv.done" -Encoding utf8