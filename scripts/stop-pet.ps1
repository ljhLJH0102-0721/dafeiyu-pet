# -*- mode: powershell -*-
<#
  stop-pet.ps1 —— 关掉桌宠（窗口 + 语音桥）

  用法：
    pwsh -File scripts\stop-pet.ps1
#>

$ErrorActionPreference = 'Continue'

function Ok($m) { Write-Host "  ✓ $m" -ForegroundColor Green }
function Info($m) { Write-Host "  $m" }

# 1) 先让她优雅退出（有接口就走接口）
try {
  Invoke-RestMethod 'http://127.0.0.1:5011/quit' -Method Post -TimeoutSec 3 -ErrorAction Stop | Out-Null
  Ok '已通知窗口退出'
} catch {
  Info '（接口没响应，直接结束进程）'
}

Start-Sleep -Seconds 1

# 2) 兜底结束窗口进程
$win = @(Get-Process -Name 'electron' -ErrorAction SilentlyContinue)
if ($win.Count -gt 0) {
  $win | ForEach-Object { try { $_.Kill() } catch {} }
  Ok "结束了 $($win.Count) 个窗口进程"
} else {
  Ok '窗口本来就没在跑'
}

# 3) 结束语音桥
$bridge = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { ($_.Name -eq 'python.exe' -or $_.Name -eq 'pythonw.exe') -and $_.CommandLine -match 'voice_bridge\.py' })
if ($bridge.Count -gt 0) {
  $bridge | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Ok "结束了 $($bridge.Count) 个语音进程"
} else {
  Ok '语音桥本来就没在跑'
}

Write-Host ''
Write-Host '  桌宠已关闭。' -ForegroundColor Gray
Write-Host ''
