# verify.ps1 — 一键验收（P0 起的所有门禁）
#
# 用法：
#   pwsh -File scripts\verify.ps1            # 全部
#   pwsh -File scripts\verify.ps1 -Fast      # 跳过集成测试（不需要桌宠在跑）
#
# 检查项：
#   1. 外壳 / 模块 JS 语法
#   2. 单元测试（node --test，含 windowState 几何回归）
#   3. 集成测试（窗口拖动稳定性；桌宠没在跑就 SKIP）
#   4. TypeScript 类型检查（Demo 的 npm test）
#   5. Python 语法检查（dafeiyu-pet 下所有 .py）

param(
  [switch]$Fast
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$node = if ($env:DSH_NODE) { $env:DSH_NODE } else { Join-Path $root 'tools\node\node.exe' }
$petDir = if ($env:PET_DIR) { $env:PET_DIR } else { 'C:\Users\Administrator\Documents\deepseek-harness\default-workspace\dafeiyu-pet' }
$vpy = Join-Path $petDir '.venv\Scripts\python.exe'

$fail = 0
$results = @()

function Step($name, [scriptblock]$fn) {
  Write-Host ""
  Write-Host "=== $name ===" -ForegroundColor Cyan
  & $fn
  if ($LASTEXITCODE -ne 0) {
    $script:fail++
    $script:results += "FAIL  $name"
    Write-Host "  FAIL (exit $LASTEXITCODE)" -ForegroundColor Red
  } else {
    $script:results += "ok    $name"
    Write-Host "  ok" -ForegroundColor Green
  }
}

Push-Location $root
try {
  Step 'JS 语法：pet-shell/main.js' {
    & $node --check 'pet-shell\main.js'
  }

  Step 'JS 语法：pet-shell/shell/*.js' {
    $bad = 0
    Get-ChildItem 'pet-shell\shell' -Filter '*.js' -ErrorAction SilentlyContinue | ForEach-Object {
      & $node --check $_.FullName
      if ($LASTEXITCODE -ne 0) { $bad++ }
    }
    if ($bad -gt 0) { exit 1 }
  }

  Step '结构门禁（check-rules）' {
    & $node 'scripts\check-rules.mjs'
  }

  Step '单元测试（node --test）' {
    & $node --test
  }

  if (-not $Fast) {
    Step '集成测试：窗口拖动稳定性' {
      & $vpy '-u' 'tests\test_window_stability.py'
    }

    Step '集成测试：API 契约' {
      & $vpy '-u' 'tests\test_api_contract.py'
    }

    Step '集成测试：全量回归（24 项，含点击穿透/缩放/设置/漫游）' {
      & $vpy '-u' 'tests\test_regressions.py' '--times' '2'
    }

    Step '集成测试：功能回归（跟随/小动作/待机）' {
      & $vpy '-u' 'tests\test_features.py'
    }

    Step '集成测试：缩放/点击不塌陷' {
      & $vpy '-u' 'tests\test_zoom_click.py'
    }
  }

  Step 'TypeScript 类型检查（tsc --noEmit）' {
    Push-Location 'Demo'
    try {
      & $node 'node_modules\typescript\bin\tsc' --noEmit
    } finally { Pop-Location }
  }

  Step '语音桥自检（--selfcheck）' {
    Push-Location $petDir
    try {
      & $vpy '-u' 'voice_bridge.py' '--selfcheck'
    } finally { Pop-Location }
  }

  Step 'Python 语法检查' {
    $bad = 0
    Get-ChildItem $petDir -Filter '*.py' -File -ErrorAction SilentlyContinue | ForEach-Object {
      & $vpy -m py_compile $_.FullName 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Write-Host ("  py_compile 失败: " + $_.Name) -ForegroundColor Red
        $bad++
      }
    }
    if ($bad -gt 0) { exit 1 }
  }
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "================ 结果 ================" -ForegroundColor Cyan
$results | ForEach-Object { Write-Host "  $_" }
if ($fail -gt 0) {
  Write-Host ""
  Write-Host "  $fail 项失败" -ForegroundColor Red
  exit 1
}
Write-Host ""
Write-Host "  全部通过" -ForegroundColor Green
exit 0
