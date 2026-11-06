# ============================================================================
# ming-games 一键发布（同步 + 体检 + 漂移检查）
# ----------------------------------------------------------------------------
# 为什么需要它：
#   2026-11-06 发现 soudache 线上落后主仓库 9 天、one-card 缺 9 个文件（含整个
#   sfx.js）。根因是"改主仓库 → 手动同步 deploy → 推送"这条链靠人记，漏一步
#   就静默落后，而页面照样能打开、体检照样全绿。
#
# 用法：
#   # 1) 只检查（默认，安全）
#   .\tools\publish.ps1
#
#   # 2) 检查 + 同步到 ming-games（不提交、不推送）
#   .\tools\publish.ps1 -Sync
#
#   # 3) 检查 + 同步 + 本地提交（仍然不推送）
#   .\tools\publish.ps1 -Sync -Commit
#
#   # 4) 全自动（同步 + 提交 + 推送 + 线上体检）
#   .\tools\publish.ps1 -Sync -Commit -Push -Verify
#
# 设计原则：
#   · 默认最安全（只读检查），危险动作必须显式开关
#   · 推送前一定要先过漂移检查 —— 有漂移就中止，不许把旧版推上去
#   · 同步时统一转 LF（ming-games 索引全是 LF，写 CRLF 会造成整文件重写）
# ============================================================================

param(
  [switch]$Sync,     # 把主仓库同步到 ming-games
  [switch]$Commit,   # 在 ming-games 里 git commit
  [switch]$Push,     # git push
  [switch]$Verify,   # 跑全站体检（需要先起 serve）
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$M = 'D:\Projects\_github_pages\ming-games'

# 主仓库 → 部署目录（zhaoyun 没有独立主仓库，跳过）
$GAMES = [ordered]@{
  'WILD'         = @{ repo = 'D:\Projects\WILD';         deploy = 'wild' }
  'SOUDACHE'     = @{ repo = 'D:\Projects\SOUDACHE';     deploy = 'soudache' }
  'ONE-CARD'     = @{ repo = 'D:\Projects\ONE-CARD';     deploy = 'one-card' }
  'BRAIN-GYM'    = @{ repo = 'D:\Projects\BRAIN-GYM';    deploy = 'brain-gym';  single = '脑力训练场·扩展版.html' }
  'NIGHT-SHIFT'  = @{ repo = 'D:\Projects\NIGHT-SHIFT';  deploy = 'night-shift' }
  'GRASS-CUTTER' = @{ repo = 'D:\Projects\GRASS-CUTTER'; deploy = 'grass-cutter' }
  'PAPER-MAZE'   = @{ repo = 'D:\Projects\PAPER-MAZE';   deploy = 'paper-maze' }
  'NEON-RHYTHM'  = @{ repo = 'D:\Projects\NEON-RHYTHM';  deploy = 'neon-rhythm' }
  'PIXEL-RUNNER' = @{ repo = 'D:\Projects\PIXEL-RUNNER'; deploy = 'pixel-runner' }
  # ★ zhaoyun 没有独立主仓库 —— 它的源码就是 ming-games/zhaoyun 本身，
  #   所以不存在"同步"这件事，加进映射反而会自己比自己。这里只留一行说明。
}

function Write-Step([string]$msg) {
  if (-not $Quiet) { Write-Host "`n▸ $msg" -ForegroundColor Cyan }
}

function Get-NormHash([string]$path) {
  $raw = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
  $lf = $raw.Replace("`r`n", "`n").Replace("`r", "`n")
  $tmp = [System.IO.Path]::GetTempFileName()
  [System.IO.File]::WriteAllText($tmp, $lf, (New-Object System.Text.UTF8Encoding($false)))
  $h = (Get-FileHash $tmp -Algorithm MD5).Hash
  Remove-Item $tmp -Force
  return $h
}

function Write-LF([string]$srcFile, [string]$dstFile) {
  $raw = [System.IO.File]::ReadAllText($srcFile, [System.Text.Encoding]::UTF8)
  $lf = $raw.Replace("`r`n", "`n").Replace("`r", "`n")
  $dir = Split-Path $dstFile -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($dstFile, $lf, (New-Object System.Text.UTF8Encoding($false)))
}

# ── 1) 收集每个游戏需要同步的文件对 ──
function Get-SyncPairs([string]$name) {
  $g = $GAMES[$name]
  $pairs = @()

  if ($g.single) {
    # 单文件 HTML 类（brain-gym）
    $src = Join-Path $g.repo $g.single
    if (Test-Path $src) {
      $pairs += @{ src = $src; dst = Join-Path $M "$($g.deploy)\index.html" }
    }
    return $pairs
  }

  # src 下的 js/mjs
  $srcDir = Join-Path $g.repo 'src'
  if (Test-Path $srcDir) {
    Get-ChildItem $srcDir -File | Where-Object { $_.Extension -in '.js', '.mjs' } | ForEach-Object {
      $pairs += @{ src = $_.FullName; dst = Join-Path $M "$($g.deploy)\src\$($_.Name)" }
    }
  }
  # config 目录（one-card 有）
  $cfgDir = Join-Path $g.repo 'config'
  if (Test-Path $cfgDir) {
    Get-ChildItem $cfgDir -File | ForEach-Object {
      $pairs += @{ src = $_.FullName; dst = Join-Path $M "$($g.deploy)\config\$($_.Name)" }
    }
  }
  # styles 目录（night-shift 有）
  $styDir = Join-Path $g.repo 'styles'
  if (Test-Path $styDir) {
    Get-ChildItem $styDir -File | ForEach-Object {
      $pairs += @{ src = $_.FullName; dst = Join-Path $M "$($g.deploy)\styles\$($_.Name)" }
    }
  }
  # 入口文件
  foreach ($f in @('index.html', 'styles.css')) {
    $sp = Join-Path $g.repo $f
    if (Test-Path $sp) { $pairs += @{ src = $sp; dst = Join-Path $M "$($g.deploy)\$f" } }
  }
  return $pairs
}

# ── 2) 漂移检查 ──
Write-Step '漂移检查（主仓库 vs 部署副本）'
$drifted = @{}
$totalDrift = 0

foreach ($name in $GAMES.Keys) {
  $pairs = Get-SyncPairs $name
  $diff = @()
  foreach ($p in $pairs) {
    if (-not (Test-Path $p.dst)) { $diff += "缺 $([System.IO.Path]::GetFileName($p.dst))" }
    elseif ((Get-NormHash $p.src) -ne (Get-NormHash $p.dst)) { $diff += [System.IO.Path]::GetFileName($p.src) }
  }
  if ($diff.Count -gt 0) {
    $drifted[$name] = $diff
    $totalDrift += $diff.Count
    Write-Host ("  ✗ {0,-14} {1} 个文件：{2}" -f $name, $diff.Count, ($diff -join ', ')) -ForegroundColor Yellow
  } elseif (-not $Quiet) {
    Write-Host ("  ✓ {0,-14} 一致" -f $name) -ForegroundColor DarkGray
  }
}

if ($totalDrift -eq 0) {
  Write-Host "`n✓ 没有漂移" -ForegroundColor Green
} else {
  Write-Host "`n✗ 共 $totalDrift 个文件有漂移" -ForegroundColor Yellow
  if (-not $Sync) {
    Write-Host "  加 -Sync 让本脚本同步它们" -ForegroundColor Yellow
  }
}

# ── 3) 同步 ──
if ($Sync -and $totalDrift -gt 0) {
  Write-Step '同步到 ming-games'
  $synced = 0
  foreach ($name in $drifted.Keys) {
    foreach ($p in (Get-SyncPairs $name)) {
      if (-not (Test-Path $p.dst)) { Write-LF $p.src $p.dst; $synced++ }
      elseif ((Get-NormHash $p.src) -ne (Get-NormHash $p.dst)) { Write-LF $p.src $p.dst; $synced++ }
    }
    Write-Host ("  ✓ {0}" -f $name) -ForegroundColor Green
  }
  Write-Host "  共写入 $synced 个文件（已统一 LF）" -ForegroundColor Green

  # 同步后复检
  Write-Step '同步后复检'
  $still = 0
  foreach ($name in $GAMES.Keys) {
    foreach ($p in (Get-SyncPairs $name)) {
      if (-not (Test-Path $p.dst)) { $still++ }
      elseif ((Get-NormHash $p.src) -ne (Get-NormHash $p.dst)) { $still++ }
    }
  }
  if ($still -eq 0) { Write-Host '  ✓ 全部一致' -ForegroundColor Green }
  else { Write-Host "  ✗ 仍有 $still 个文件不一致，中止" -ForegroundColor Red; exit 1 }
}

# ── 4) 提交 ──
if ($Commit) {
  Write-Step 'git 提交（ming-games）'
  Push-Location $M
  try {
    $status = git status --short 2>&1
    if (-not $status) {
      Write-Host '  没有改动可提交' -ForegroundColor DarkGray
    } else {
      git add -A 2>&1 | Out-Null
      $msg = "sync: 主仓库 → ming-games 部署副本（自动发布）"
      git -c core.quotepath=false commit -m $msg 2>&1 | Select-Object -Last 2 | ForEach-Object { Write-Host "  $_" }
      Write-Host "  HEAD: $(git rev-parse --short HEAD)" -ForegroundColor Green
    }
  } finally { Pop-Location }
}

# ── 5) 推送 ──
if ($Push) {
  if ($totalDrift -gt 0 -and -not $Sync) {
    Write-Host "`n✗ 有漂移且没同步，拒绝推送" -ForegroundColor Red
    exit 1
  }
  Write-Step 'git push'
  Push-Location $M
  try {
    $env:GIT_SSH_COMMAND = 'ssh -o StrictHostKeyChecking=no -o BatchMode=yes'
    git push origin master 2>&1 | Select-Object -Last 2 | ForEach-Object { Write-Host "  $_" }
    git fetch origin master 2>&1 | Out-Null
    $local = git rev-parse --short master
    $remote = git rev-parse --short origin/master
    if ($local -eq $remote) { Write-Host "  ✓ 已推送（$local）" -ForegroundColor Green }
    else { Write-Host "  ✗ 推送不一致 local=$local remote=$remote" -ForegroundColor Red; exit 1 }
  } finally { Pop-Location }
}

# ── 6) 体检 ──
if ($Verify) {
  Write-Step '全站体检'
  $node = 'C:\Users\31474\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
  $edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
  $prof = Join-Path $M '.tmp\cdp-profile'
  New-Item -ItemType Directory -Force -Path $prof | Out-Null

  $env:PORT = '5199'
  $srv = Start-Process -FilePath $node -ArgumentList 'tools/serve.mjs' -WorkingDirectory $M -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 2
  $argStr = "--headless=new --remote-debugging-port=9340 --user-data-dir=$prof --no-first-run --no-default-browser-check --mute-audio --window-size=375,667 about:blank"
  $edgeProc = Start-Process -FilePath $edge -ArgumentList $argStr -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 5
  try {
    $env:CDP_PORT = '9340'
    $env:SITE_BASE = 'http://localhost:5199/'
    Push-Location $M
    & $node tools/health-check.mjs
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { Write-Host "`n✗ 体检未全过" -ForegroundColor Red }
  } finally {
    Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $edgeProc.Id -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "`n═══ 完成 ═══" -ForegroundColor Cyan
if ($totalDrift -eq 0) { exit 0 } else { exit $(if ($Sync) { 0 } else { 1 }) }
