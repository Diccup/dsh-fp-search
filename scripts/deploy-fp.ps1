/*
 * ============================================================================
 * 本文件由 AI 辅助生成（AI-generated / AI-assisted）。
 *
 * 免责声明：
 *   本项目不对正确性、稳定性、适销性或特定用途适用性作任何明示或默示担保。
 *   使用本插件造成的任何直接或间接损失，作者与团队均不承担责任。
 *   请自行评估风险，并优先遵守所在地区的法律法规与服务商协议。
 *   完整声明见仓库根目录的 DISCLAIMER.md。
 * ============================================================================
 */
# deploy-fp.ps1 — FP 单次提权装机：备份 / 同步 / 对拍 / 槽内自检 / 装载门，一次跑完
#
# ★ 跑法（**别用 `pwsh -File` 包一层，那会多开一个控制台窗口，屏幕上闪一下黑框**）：
#   已经在一个 PowerShell 里时，直接点路径跑：
#       & '.\scripts\deploy-fp.ps1'
#   双击/从别处启动、要求不闪窗时：
#       Start-Process pwsh -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','<本脚本>' -WindowStyle Hidden -Wait
#   2026-11-09 维护方当场问「为什么刚才闪了一个 CMD 的黑框」—— 原因就是上一版调用方
#   在 pwsh 里又套了一层 `pwsh -File`，Windows 给子进程开了个控制台窗口。
#   **脚本本身无罪，是调用方式的问题**，头注写明防后人重踩。
#
# 设计原则（2026-11-09 维护方指出"装一次让我授权 9 次"之后定的）：
#   装机是**一件事**，必须一个提权、一次跑完、一次输出结论。
#   不许拆成"备份一次 / 复制一次 / 对拍一次 / 自检一次"逐个申请权限。

$ErrorActionPreference = 'Stop'

# ★ 发布版可移植化（2026-11-16）：源目录、profile 名、node 路径全部改成探测式。
#   原先写死 F:\workspace\LongMem\Work\dsh-fp-search / C:\Users\Diccup\... / profile 名 desktop。
$repo  = Split-Path -Parent $PSScriptRoot
$DshRoot = Join-Path $env:USERPROFILE '.dsh'
$RuntimeDir = Join-Path $DshRoot 'dsh-runtimes\dsh-primary-runtime\dependencies'
$node  = Join-Path $RuntimeDir 'node\bin\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }

# profile 目录：profiles\ 下第一个带 package.json 的子目录（通常只有一个）
$ProfileName = 'desktop'
$ProfilesRoot = Join-Path $DshRoot 'profiles'
if (Test-Path $ProfilesRoot) {
    $hit = Get-ChildItem -Directory $ProfilesRoot -ErrorAction SilentlyContinue |
           Where-Object { Test-Path (Join-Path $_.FullName 'package.json') } |
           Select-Object -First 1
    if ($hit) { $ProfileName = $hit.Name }
}
$slot  = Join-Path $DshRoot 'plugins\dsh-fp-search'
$prof  = Join-Path $DshRoot "profiles\$ProfileName\node_modules\dsh-fp-search"
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bk    = Join-Path $repo "backups\pre-install-$stamp"

$items = @('platform','engine','ours','fp','deps','skills','scripts',
           'cordis.patch.yml','README.md','LICENSE','ASSEMBLY.json','package.json')

$fail = @()
function Step($name) { Write-Host "`n=== $name ===" -ForegroundColor Cyan }

# ---------------------------------------------------------------- 1 备份
Step "1/5 备份"
New-Item -ItemType Directory -Path $bk -Force | Out-Null
if (Test-Path $slot) { Copy-Item $slot "$bk\slot" -Recurse -Force }
if (Test-Path $prof) { Copy-Item $prof "$bk\prof" -Recurse -Force }
$bkCount = (Get-ChildItem $bk -Recurse -File -ErrorAction SilentlyContinue).Count
Write-Host "备份 $bkCount 件 → $bk"

# ---------------------------------------------------------------- 2 同步
Step "2/5 同步到槽 + profile 副本"
foreach ($dst in @($slot, $prof)) {
    if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Path $dst -Force | Out-Null }
    foreach ($i in $items) {
        $src = Join-Path $repo $i
        if (-not (Test-Path $src)) { $fail += "缺源 $src"; continue }
        try { Copy-Item -Path $src -Destination $dst -Recurse -Force -ErrorAction Stop }
        catch { $fail += "复制失败 $dst\$i : $($_.Exception.Message)" }
    }
}
$slotCount = (Get-ChildItem $slot -Recurse -File).Count
$profCount = (Get-ChildItem $prof -Recurse -File).Count
Write-Host "槽 = $slotCount 件 / profile = $profCount 件"

# ---------------------------------------------------------------- 3 逐件对拍
Step "3/5 逐件 SHA256 对拍（仓根 ↔ 槽 ↔ profile）"
$n = 0; $diff = @()
foreach ($i in @('platform','engine','ours','fp','deps','skills','scripts')) {
    $dir = Join-Path $repo $i
    if (-not (Test-Path $dir)) { continue }
    foreach ($f in (Get-ChildItem $dir -Recurse -File)) {
        $rel = $f.FullName.Substring($repo.Length + 1)
        $h = (Get-FileHash $f.FullName -Algorithm SHA256).Hash
        $n++
        foreach ($pair in @(@('槽', (Join-Path $slot $rel)), @('profile', (Join-Path $prof $rel)))) {
            if (-not (Test-Path $pair[1])) { $diff += "缺 $($pair[0]) $rel" }
            elseif ((Get-FileHash $pair[1] -Algorithm SHA256).Hash -ne $h) { $diff += "差异 $($pair[0]) $rel" }
        }
    }
}
if ($diff.Count -eq 0) { Write-Host "比对 $n 件，差异 0 ✅" -ForegroundColor Green }
else { Write-Host "比对 $n 件，差异 $($diff.Count) ❌" -ForegroundColor Red; $diff | Select-Object -First 10; $fail += "哈希对拍未过" }

# ---------------------------------------------------------------- 4 profile 注册
Step "4/5 profile 注册核对"
$pkgPath = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\package.json'
if (Test-Path $pkgPath) {
    $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
    $hasDep = ($null -ne $pkg.dependencies.'dsh-fp-search')
    $hasBundle = ($pkg.dsh.profile.bundles -contains 'dsh-fp-search')
    Write-Host "dependencies 含 dsh-fp-search = $hasDep"
    Write-Host "bundles 含 dsh-fp-search      = $hasBundle"
    if (-not ($hasDep -and $hasBundle)) { $fail += 'profile 注册不全（dependencies 或 bundles 缺）' }
} else { $fail += "找不到 $pkgPath" }

# ---------------------------------------------------------------- 5 槽内自检
Step "5/5 槽内自检（自检 / 工具面 / 装载门）"
$checks = @(
    @('index --selftest',      @("$slot\engine\index.mjs", '--selftest')),
    @('tool-surface --dir',    @("$slot\engine\verify\tool-surface.mjs", '--dir', $slot)),
    @('plugin-load',           @("$slot\engine\verify\plugin-load.mjs"))
)
foreach ($c in $checks) {
    $out = & $node @($c[1]) 2>&1
    $code = $LASTEXITCODE
    $tail = ($out | Select-Object -Last 2) -join ' | '
    if ($code -eq 0) { Write-Host "PASS  $($c[0])  — $tail" -ForegroundColor Green }
    else { Write-Host "FAIL  $($c[0])  EXIT=$code  — $tail" -ForegroundColor Red; $fail += "槽内自检失败：$($c[0])" }
}

# ---------------------------------------------------------------- 结论
Write-Host ''
if ($fail.Count -eq 0) {
    Write-Host '===== 装机完成 ✅ 请重启 DSH，然后在**新会话**里跑 fp({op:"doctor"}) 应见 23 家 =====' -ForegroundColor Green
    Write-Host "回滚备份：$bk"
    exit 0
} else {
    Write-Host '===== 装机有问题 ❌ =====' -ForegroundColor Red
    $fail | ForEach-Object { Write-Host "  - $_" }
    Write-Host "回滚：把 $bk\slot 与 $bk\prof 覆盖回原位"
    exit 1
}
