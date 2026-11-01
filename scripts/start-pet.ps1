# -*- mode: powershell -*-
<#
  start-pet.ps1 —— 启动桌宠（窗口 + 语音桥）

  设计原则：
    · 已经在跑就不重复启动（按 :5011 是否响应判断）
    · 不弹黑框（自己隐藏控制台）
    · electron 路径自动找：环境变量 → app\node_modules → tools\electron
    · 必须清掉 ELECTRON_RUN_AS_NODE，否则 electron 会被当成纯 Node 跑

  用法：
    pwsh -File scripts\start-pet.ps1            # 都要
    pwsh -File scripts\start-pet.ps1 -NoVoice   # 只开窗口，不开语音
#>

param(
  [switch]$NoVoice,
  [string]$Model = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# 目录自适应：开源仓库布局（app/renderer/brain）与本地开发布局（pet-shell/Demo/dafeiyu-pet）
function Pick-Dir($names) {
  foreach ($n in $names) {
    $p = Join-Path $root $n
    if (Test-Path $p) { return $p }
  }
  return Join-Path $root $names[0]
}
$appDir = Pick-Dir @('app', 'pet-shell')
$brainDir = $env:PET_PY_DIR
if (-not $brainDir -or -not (Test-Path $brainDir)) { $brainDir = Pick-Dir @('brain', 'dafeiyu-pet', '..\dafeiyu-pet') }
$legacyBrain = Join-Path $env:USERPROFILE 'Documents\deepseek-harness\default-workspace\dafeiyu-pet'
if (-not (Test-Path (Join-Path $brainDir 'voice_bridge.py')) -and (Test-Path (Join-Path $legacyBrain 'voice_bridge.py'))) { $brainDir = $legacyBrain }
$rendererDir = Pick-Dir @('renderer', 'Demo')

function Info($m) { Write-Host "  $m" }
function Ok($m) { Write-Host "  ✓ $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  ! $m" -ForegroundColor Yellow }
function Bad($m) { Write-Host "  ✗ $m" -ForegroundColor Red }

# ── 已经在跑？ ───────────────────────────────────────────
function Test-PetRunning {
  try {
    $r = Invoke-RestMethod 'http://127.0.0.1:5011/state' -TimeoutSec 2
    return [bool]$r.ok
  } catch { return $false }
}

function Test-BridgeRunning {
  $n = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { ($_.Name -eq 'python.exe' -or $_.Name -eq 'pythonw.exe') -and $_.CommandLine -match 'voice_bridge\.py' }).Count
  return $n -gt 0
}

# ── 找 electron ──────────────────────────────────────────
function Resolve-Electron {
  $cands = @()
  if ($env:PET_ELECTRON) { $cands += $env:PET_ELECTRON }
  $cands += (Join-Path $appDir 'node_modules\electron\dist\electron.exe')
  $cands += (Join-Path $root 'tools\electron\electron.exe')
  foreach ($c in $cands) { if (Test-Path $c) { return $c } }
  return $null
}

# ── 找语音桥的 python ───────────────────────────────────
function Resolve-Python {
  $cands = @(
    (Join-Path $brainDir '.venv\Scripts\pythonw.exe'),
    (Join-Path $brainDir '.venv\Scripts\python.exe')
  )
  foreach ($c in $cands) { if (Test-Path $c) { return $c } }
  return $null
}

Write-Host ''
Write-Host '大肥鱼桌宠' -ForegroundColor Cyan
Write-Host ''

# ── 1. 窗口 ─────────────────────────────────────────────
if (Test-PetRunning) {
  Ok '桌宠已经在跑了（没有重复启动）'
} else {
  $electron = Resolve-Electron
  if (-not $electron) {
    Bad '找不到 electron'
    Info '第一次用，请先在 app 目录装一次：'
    Info '    cd app'
    Info '    npm install'
    exit 1
  }

  if (-not $Model) {
    $res = Join-Path $rendererDir 'public\Resources'
    if (Test-Path $res) {
      # 优先用「大肥鱼」；没有就取第一个模型
      if (Test-Path (Join-Path $res '大肥鱼')) {
        $Model = '大肥鱼'
      } else {
        $Model = (Get-ChildItem $res -Directory -ErrorAction SilentlyContinue | Select-Object -First 1).Name
      }
    }
  }
  if (-not $Model) { $Model = '大肥鱼' }

  # 关键：不清掉这个变量，electron 会以纯 Node 模式启动并报 Cannot find module 'electron'
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

  Info "启动窗口（模型 $Model）…"
  Start-Process -FilePath $electron `
    -ArgumentList @($appDir, '--model', $Model, '--w', '520', '--h', '760') `
    -WorkingDirectory $root -WindowStyle Hidden | Out-Null

  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-PetRunning) { $ready = $true; break }
  }
  if ($ready) { Ok '窗口起来了' } else { Warn '窗口好像没起来，看看 app\pet-shell.log' }
}

# ── 2. 语音 ─────────────────────────────────────────────
if ($NoVoice) {
  Info '（按参数要求，没有启动语音）'
} elseif (Test-BridgeRunning) {
  Ok '语音桥已经在跑了'
} else {
  $py = Resolve-Python
  if (-not $py) {
    Warn '没装语音环境（brain\.venv 不存在），跳过语音'
    Info '想要语音：cd brain && python -m venv .venv && .venv\Scripts\pip install -r requirements.txt'
  } elseif (-not (Test-Path (Join-Path $brainDir 'voice_bridge.json'))) {
    Warn '缺 brain\voice_bridge.json（没有 API 配置），跳过语音'
  } else {
    Info '启动语音桥…'
    Start-Process -FilePath $py `
      -ArgumentList @((Join-Path $brainDir 'voice_bridge.py')) `
      -WorkingDirectory $brainDir -WindowStyle Hidden | Out-Null
    Start-Sleep -Seconds 3
    if (Test-BridgeRunning) { Ok '语音桥起来了' } else { Warn '语音桥没起来，看看 brain\voice_bridge.log' }
  }
}

Write-Host ''
Write-Host '  提示：右键点她 →「设置…」改 API / 音量 / 漫游' -ForegroundColor Gray
Write-Host '        右键托盘图标 →「退出」结束' -ForegroundColor Gray
Write-Host ''