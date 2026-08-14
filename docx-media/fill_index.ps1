
$ErrorActionPreference = 'Stop'
$path = 'C:\document\工作\docs\项目\蒲城石坡镇\等保\身份鉴别整改材料（修订版）-优化版.docx'

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Open($path)

  # 1) 更新目录域（先更新 TOC，页码才会正确）
  try {
    if ($doc.TablesOfContents.Count -gt 0) { $doc.TablesOfContents.Item(1).Update() }
  } catch { Write-Output "TOC update via TablesOfContents failed: $($_.Exception.Message)" }
  $doc.Fields.Update() | Out-Null

  # 2) 定位各图/表题所在页码
  $captions = @(
    '图 1：数据库服务器（192.168.110.23）',
    '图 2：后台服务器（192.168.110.22）',
    '图 3：中间件服务器（192.168.110.25）',
    '图 4：应用服务器（192.168.110.21）',
    '图 5：文件服务器（192.168.110.24）',
    '图 6：宿主机（192.168.110.20）',
    '表 1：整改项信息表',
    '表 2：适用资产清单'
  )
  $pages = @{}
  foreach ($t in $captions) {
    $r = $doc.Content
    $f = $r.Find
    $f.ClearFormatting()
    $f.Text = $t
    $f.Forward = $true
    $f.Wrap = 1
    if ($f.Execute()) {
      $pages[$t] = $r.Information(3)
    } else {
      $pages[$t] = -1
    }
  }

  # 3) 填图表索引页码
  foreach ($tbl in $doc.Tables) {
    $h1 = $tbl.Cell(1,1).Range.Text.Trim()
    $h2 = $tbl.Cell(1,2).Range.Text.Trim()
    if ($h1 -like '编号*' -and $h2 -like '图题*') {
      for ($i = 2; $i -le 7; $i++) { $tbl.Cell($i, 3).Range.Text = [string]$pages[$captions[$i - 2]] }
    } elseif ($h1 -like '编号*' -and $h2 -like '表题*') {
      for ($i = 2; $i -le 3; $i++) { $tbl.Cell($i, 3).Range.Text = [string]$pages[$captions[4 + $i]] }
    }
  }

  $doc.Save()
  $doc.Close()
  Write-Output '--- caption page map ---'
  foreach ($t in $captions) { Write-Output "$t => $($pages[$t])" }
  Write-Output '--- TOC entries ---'
  if ($doc.TablesOfContents.Count -gt 0) {
    $toc = $doc.TablesOfContents.Item(1)
    Write-Output "TOC range pages: $($toc.Range.Information(3))"
  }
} finally {
  $word.Quit()
  [System.Runtime.Interopservices.Marshal]::ReleaseComObject($word) | Out-Null
}
