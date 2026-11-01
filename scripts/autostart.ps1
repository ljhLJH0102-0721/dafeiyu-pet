# -*- mode: powershell -*-
<#
  autostart.ps1 —— 开机自启 / 快捷方式 一键开关

  做的事：
    · 在「启动」文件夹放一个指向 启动桌宠.cmd 的快捷方式 → 开机自动跑
    · 在桌面放一个快捷方式 → 手动双击打开
    · 在开始菜单放一个快捷方式

  用法：
    pwsh -File scripts\autostart.ps1                 # 看当前状态
    pwsh -File scripts\autostart.ps1 -Install        # 装（自启 + 桌面 + 开始菜单）
    pwsh -File scripts\autostart.ps1 -Install -NoAuto # 只建快捷方式，不自启
    pwsh -File scripts\autostart.ps1 -Remove         # 全部卸载
#>

param(
  [switch]$Install,
  [switch]$Remove,
  [switch]$NoAuto
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $root '启动桌宠.cmd'

$startupDir = [Environment]::GetFolderPath('Startup')
$desktopDir = [Environment]::GetFolderPath('Desktop')
$startMenuDir = Join-Path ([Environment]::GetFolderPath('Programs')) '大肥鱼桌宠'

$startupLink = Join-Path $startupDir '大肥鱼桌宠.lnk'
$desktopLink = Join-Path $desktopDir '大肥鱼桌宠.lnk'
$menuLink = Join-Path $startMenuDir '大肥鱼桌宠.lnk'

function Ok($m) { Write-Host "  ✓ $m" -ForegroundColor Green }
function Info($m) { Write-Host "  $m" }
function Warn($m) { Write-Host "  ! $m" -ForegroundColor Yellow }

function New-Shortcut($path, $target, $workDir, $desc, $extraArgs = '') {
  $dir = Split-Path -Parent $path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($path)
  $sc.TargetPath = $target
  $sc.Arguments = $extraArgs
  $sc.WorkingDirectory = $workDir
  $sc.Description = $desc
  $sc.IconLocation = $target + ',0'
  $sc.WindowStyle = 7      # 最小化启动，避免黑框闪一下
  $sc.Save()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
}

$target = 'C:\Windows\System32\cmd.exe'
# 注意：$args 是 PowerShell 的自动变量，不能直接赋值
$cmdArgs = '/c ""' + $launcher + '""'

# ── 状态 ────────────────────────────────────────────────
if (-not $Install -and -not $Remove) {
  Write-Host ''
  Write-Host '大肥鱼桌宠 · 自启与快捷方式' -ForegroundColor Cyan
  Write-Host ''
  Info ("开机自启:   " + $(if (Test-Path $startupLink) { '已开启' } else { '未开启' }))
  Info ("桌面快捷方式: " + $(if (Test-Path $desktopLink) { '已创建' } else { '未创建' }))
  Info ("开始菜单:   " + $(if (Test-Path $menuLink) { '已创建' } else { '未创建' }))
  Write-Host ''
  Info '开启:  pwsh -File scripts\autostart.ps1 -Install'
  Info '关闭:  pwsh -File scripts\autostart.ps1 -Remove'
  Write-Host ''
  exit 0
}

# ── 卸载 ────────────────────────────────────────────────
if ($Remove) {
  foreach ($p in @($startupLink, $desktopLink, $menuLink)) {
    if (Test-Path $p) { Remove-Item $p -Force; Ok "已删除 $p" }
  }
  if (Test-Path $startMenuDir) { Remove-Item $startMenuDir -Recurse -Force -ErrorAction SilentlyContinue }
  Write-Host ''
  Ok '已全部卸载'
  Write-Host ''
  exit 0
}

# ── 安装 ────────────────────────────────────────────────
if (-not (Test-Path $launcher)) {
  Warn "找不到启动脚本：$launcher"
  exit 1
}

# 桌面 + 开始菜单
New-Shortcut $desktopLink $target $root '启动大肥鱼桌宠' $cmdArgs
Ok '桌面快捷方式已创建'

New-Shortcut $menuLink $target $root '启动大肥鱼桌宠' $cmdArgs
Ok '开始菜单快捷方式已创建'

# 开机自启
if ($NoAuto) {
  Info '（按参数要求，没有设开机自启）'
} else {
  New-Shortcut $startupLink $target $root '开机自动启动大肥鱼桌宠' $cmdArgs
  Ok '开机自启已开启'
}

Write-Host ''
Info '下次开机她会自己出来；也可以随时双击桌面图标打开。'
Write-Host ''
