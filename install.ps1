# -*- mode: powershell -*-
<#
  install.ps1 —— 一键安装大肥鱼桌宠

  做的事：
    1. 检查 Node / Python
    2. 安装 renderer 的 npm 依赖并构建页面
    3. 建 brain/.venv 并安装 Python 依赖
    4. 检查 Cubism Core 与模型文件是否就位（缺了给出确切路径）
    5. 生成 brain/voice_bridge.json 配置模板

  用法：
    pwsh -File install.ps1                # 全装
    pwsh -File install.ps1 -SkipBuild     # 不重新构建页面
#>

param(
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Say($msg) { Write-Host "  $msg" }
function Step($msg) { Write-Host ""; Write-Host "=== $msg ===" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "  ✗ $msg" -ForegroundColor Red; exit 1 }
function Ok($msg) { Write-Host "  ✓ $msg" -ForegroundColor Green }

# ── 1. 环境检查 ─────────────────────────────────────────
Step '检查环境'

$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { Fail '没找到 node。请先装 Node.js 18+（https://nodejs.org）' }
$nodeVer = (& node --version).Trim()
Ok "Node $nodeVer"

$py = (Get-Command python -ErrorAction SilentlyContinue)
if (-not $py) { Fail '没找到 python。请先装 Python 3.10+（https://python.org）' }
$pyVer = (& python --version).Trim()
Ok $pyVer

# ── 2. 前端依赖与构建 ────────────────────────────────────
Step '安装前端依赖'
Push-Location (Join-Path $root 'renderer')
try {
  if (-not (Test-Path 'node_modules')) {
    Say 'npm install（第一次会比较慢）…'
    & npm install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { Fail 'npm install 失败' }
  } else {
    Ok 'node_modules 已存在，跳过'
  }

  if (-not $SkipBuild) {
    Say '构建页面…'
    & node node_modules\vite\bin\vite.js build
    if ($LASTEXITCODE -ne 0) { Fail 'vite build 失败' }
    Ok '页面已构建到 renderer/dist'
  }
} finally {
  Pop-Location
}

# ── 3. Python 环境 ──────────────────────────────────────
Step '安装语音依赖'
$brain = Join-Path $root 'brain'
$venv = Join-Path $brain '.venv'
if (-not (Test-Path $venv)) {
  Say '创建虚拟环境…'
  & python -m venv $venv
}
$vpy = Join-Path $venv 'Scripts\python.exe'
Say 'pip install -r requirements.txt …'
& $vpy -m pip install --upgrade pip --quiet
& $vpy -m pip install -r (Join-Path $brain 'requirements.txt')
if ($LASTEXITCODE -ne 0) { Fail 'pip install 失败（PyAudio 需要先装 Visual C++ 运行库）' }
Ok 'Python 依赖装好'

# ── 4. 资源检查 ─────────────────────────────────────────
Step '检查 Live2D 资源（这些不能随仓库分发，需要你自备）'
$renderer = Join-Path $root 'renderer'
$core = Join-Path $renderer 'public\Core\live2dcubismcore.js'
$resDir = Join-Path $renderer 'public\Resources'

$missing = 0
if (-not (Test-Path $core)) {
  Write-Host '  ✗ 缺 Cubism Core（仓库里应该自带；被 .gitignore 挡了？）' -ForegroundColor Yellow
  Say '    放到: renderer\public\Core\live2dcubismcore.js'
  Say '    来源: https://www.live2d.com/sdk/cubism/sdk-download/'
  $missing++
} else { Ok 'Cubism Core 就位（随仓库提供）' }

$framework = Join-Path $root 'Framework\src'
if (-not (Test-Path $framework)) {
  Write-Host '  ✗ 缺 Cubism Framework 源码（仓库里应该自带）' -ForegroundColor Yellow
  $missing++
} else { Ok 'Cubism Framework 就位（随仓库提供）' }

$models = @()
if (Test-Path $resDir) {
  $models = Get-ChildItem $resDir -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
}
if ($models.Count -eq 0) {
  Write-Host '  ✗ 还没有模型' -ForegroundColor Yellow
  Say '    放到: renderer\public\Resources\<模型名>\'
  $missing++
} else {
  Ok ('可用模型: ' + ($models -join ', '))
}

# ── 5. 配置模板 ─────────────────────────────────────────
Step '生成配置'
$cfg = Join-Path $brain 'voice_bridge.json'
if (-not (Test-Path $cfg)) {
  @'
{
  "brain_mode": "api",
  "llm": {
    "base_url": "https://api.deepseek.com",
    "model": "deepseek-flash",
    "api_key": "在这里填你的 API Key",
    "api_key_env": "DEEPSEEK_API_KEY",
    "timeout_s": 30
  },
  "device_index": -1,
  "context_turns": 3,
  "ocr_max_lines": 16,
  "require_wake": false
}
'@ | Set-Content $cfg -Encoding utf8
  Ok '已生成 brain\voice_bridge.json（记得填 API Key）'
} else {
  Ok '配置已存在，未覆盖'
}

# ── 6. 收尾 ─────────────────────────────────────────────
Step '完成'
if ($missing -gt 0) {
  Write-Host "  还有 $missing 项资源缺失，按上面的提示放好后重新运行本脚本。" -ForegroundColor Yellow
  Write-Host ''
  Write-Host '  只想要聊天 + 点屏幕（不带语音）时，资源补齐后直接跑：' -ForegroundColor Gray
} 
$modelName = if ($models.Count -gt 0) { $models[0] } else { '你的模型名' }
Write-Host ''
Write-Host '  启动桌宠：' -ForegroundColor Gray
Write-Host "    node app\main.js --model $modelName --w 520 --h 760" -ForegroundColor White
Write-Host ''
Write-Host '  再启动语音（另开一个窗口）：' -ForegroundColor Gray
Write-Host '    brain\.venv\Scripts\python.exe brain\voice_bridge.py' -ForegroundColor White
Write-Host ''
Write-Host '  打开设置：右键点她 →「设置…」' -ForegroundColor Gray
