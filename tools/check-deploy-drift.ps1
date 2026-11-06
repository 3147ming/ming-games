# 全站部署漂移检查：主仓库 vs ming-games 部署副本
#
# 为什么需要这个脚本：
#   2026-11-06 发现 soudache 的线上版本落后主仓库 9 天（第三批 12 条 / 移动端修复包 /
#   手感画质打磨全部没上线），而"体检脚本"只验证页面能不能打开，看不出"跑的是旧版"。
#   这个脚本逐文件比对，把"积压未部署"变成可量化的数字。

$ErrorActionPreference = 'Stop'
$m = 'D:\Projects\_github_pages\ming-games'

# 主仓库 → 部署目录 的映射（zhaoyun 没有独立主仓库，跳过）
$games = [ordered]@{
  'WILD'        = @{ repo = 'D:\Projects\WILD';        deploy = 'wild';         src = 'src' }
  'SOUDACHE'    = @{ repo = 'D:\Projects\SOUDACHE';    deploy = 'soudache';     src = 'src' }
  'ONE-CARD'    = @{ repo = 'D:\Projects\ONE-CARD';    deploy = 'one-card';     src = 'src' }
  'BRAIN-GYM'   = @{ repo = 'D:\Projects\BRAIN-GYM';   deploy = 'brain-gym';    src = '' }      # 单文件 HTML
  'NIGHT-SHIFT' = @{ repo = 'D:\Projects\NIGHT-SHIFT'; deploy = 'night-shift';  src = 'src' }
  'GRASS-CUTTER'= @{ repo = 'D:\Projects\GRASS-CUTTER';deploy = 'grass-cutter'; src = 'src' }
  'PAPER-MAZE'  = @{ repo = 'D:\Projects\PAPER-MAZE';  deploy = 'paper-maze';   src = 'src' }
  'NEON-RHYTHM' = @{ repo = 'D:\Projects\NEON-RHYTHM'; deploy = 'neon-rhythm';  src = 'src' }
  'PIXEL-RUNNER'= @{ repo = 'D:\Projects\PIXEL-RUNNER';deploy = 'pixel-runner'; src = 'src' }
}

function Get-NormalizedHash([string]$path) {
  $raw = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
  $lf = $raw.Replace("`r`n", "`n").Replace("`r", "`n")
  $tmp = [System.IO.Path]::GetTempFileName()
  [System.IO.File]::WriteAllText($tmp, $lf, (New-Object System.Text.UTF8Encoding($false)))
  $h = (Get-FileHash $tmp -Algorithm MD5).Hash
  Remove-Item $tmp -Force
  return $h
}

"═════════ 全站部署漂移检查 ═════════"
"{0,-14} {1,-8} {2,-8} {3}" -f '游戏', '漂移文件', '未部署', '状态'
"─" * 60

$totalDrift = 0
$details = @()

foreach ($name in $games.Keys) {
  $g = $games[$name]
  $drift = 0
  $missing = 0
  $reasons = @()

  if ($g.src -eq '') {
    # 单文件类游戏：直接比入口
    $srcFile = $null
    foreach ($cand in @('脑力训练场·扩展版.html', 'index.html')) {
      $p = Join-Path $g.repo $cand
      if (Test-Path $p) { $srcFile = $p; break }
    }
    $deployFile = Join-Path $m "$($g.deploy)\index.html"
    if ($srcFile -and (Test-Path $deployFile)) {
      if ((Get-NormalizedHash $srcFile) -ne (Get-NormalizedHash $deployFile)) {
        $drift++; $reasons += 'index.html'
      }
    }
  } else {
    $srcDir = Join-Path $g.repo $g.src
    $deployDir = Join-Path $m "$($g.deploy)\$($g.src)"
    if (Test-Path $srcDir) {
      Get-ChildItem $srcDir -File | Where-Object { $_.Extension -in '.js', '.mjs' } | ForEach-Object {
        $d = Join-Path $deployDir $_.Name
        if (-not (Test-Path $d)) {
          $missing++
          $reasons += "缺 $($_.Name)"
        } elseif ((Get-NormalizedHash $_.FullName) -ne (Get-NormalizedHash $d)) {
          $drift++
          $reasons += $_.Name
        }
      }
    }
    # 入口文件
    foreach ($f in @('index.html', 'styles.css')) {
      $sp = Join-Path $g.repo $f
      $dp = Join-Path $m "$($g.deploy)\$f"
      if ((Test-Path $sp) -and (Test-Path $dp)) {
        if ((Get-NormalizedHash $sp) -ne (Get-NormalizedHash $dp)) {
          $drift++; $reasons += $f
        }
      }
    }
  }

  $status = if ($drift -eq 0 -and $missing -eq 0) { '✓ 一致' } else { '✗ 有漂移' }
  "{0,-14} {1,-8} {2,-8} {3}" -f $name, $drift, $missing, $status
  if ($reasons.Count -gt 0) {
    $totalDrift += $drift + $missing
    $details += "  $name : $($reasons -join ', ')"
  }
}

"─" * 60
if ($totalDrift -eq 0) {
  "✓ 全部一致，没有积压未部署的改动"
} else {
  "✗ 共 $totalDrift 个文件有漂移："
  $details | ForEach-Object { $_ }
  exit 1
}
