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
# dsh-fp-search 装载脚本（由维护方双击运行）— v3 · 正确注册路
#
# 为什么有 v3：v1「复制进 plugins\ 就行」是错的（DSH 不扫那个目录）；
# v2 用 PowerShell 的 ConvertTo-Json 改 profile，PS5.1/PS7 行为不一致且有风险。
# v3 把「改 profile」这件事交给 node 脚本（scripts\register-fp.mjs）：
#   · 确定性 JSON 处理；· 带安全闸（除目标两处外任何改动都拒绝写）；
#   · 写前备份、临时文件原子替换、写后复验、失败自动回滚；
#   · 已被 engine\verify\register-gate.mjs 验证到「反注册后完整节还原」。
#
# 三件套（缺一不加载，出处 dsh-team/INSTALL.md §2a/2b）：
#   ① plugins 里的实体  ② profile dependencies 的 link:  ③ profile bundles 里的包名
#   ④ 另加一步 pnpm install 建 node_modules 链接

$ErrorActionPreference = 'Stop'
try { chcp 65001 | Out-Null } catch {}

$PkgName    = 'dsh-fp-search'
$RepoWork   = Split-Path -Parent $PSScriptRoot
$PluginDir  = Join-Path $env:USERPROFILE ".dsh\plugins\$PkgName"

# ★ 发布版可移植化（2026-11-16）：原先写死 `C:\Users\Diccup\...` 和 profile 名 `desktop`。
#   现在全部探测：DSH runtime 目录按 $env:USERPROFILE 推，profile 目录按实际存在的那个推。
$DshRoot    = Join-Path $env:USERPROFILE '.dsh'
$RuntimeDir = Join-Path $DshRoot 'dsh-runtimes\dsh-primary-runtime\dependencies'
$Node = Join-Path $RuntimeDir 'node\bin\node.exe'
if (-not (Test-Path $Node)) { $Node = (Get-Command node -ErrorAction SilentlyContinue).Source }
$Pnpm = Join-Path $RuntimeDir 'pnpm\bin\pnpm.cjs'
if (-not (Test-Path $Pnpm)) { $Pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue).Source }

# profile 目录：profiles\ 下第一个带 package.json 的子目录（通常只有一个）
$ProfileDir = ''
$ProfilesRoot = Join-Path $DshRoot 'profiles'
if (Test-Path $ProfilesRoot) {
    $hit = Get-ChildItem -Directory $ProfilesRoot -ErrorAction SilentlyContinue |
           Where-Object { Test-Path (Join-Path $_.FullName 'package.json') } |
           Select-Object -First 1
    if ($hit) { $ProfileDir = $hit.FullName }
}
if ($ProfileDir -eq '') { $ProfileDir = Join-Path $ProfilesRoot 'desktop' }
$Reg  = Join-Path $RepoWork 'scripts\register-fp.mjs'

function Line($t = '') { Write-Host $t }
function Head($t) { Line ''; Write-Host ('=' * 62); Write-Host $t; Write-Host ('=' * 62) }

Head "FP 装载 v3 · $PkgName"

# ---- 0. 前置 ----
if (-not (Test-Path $Node)) { Line "✗ 找不到 node：$Node"; Read-Host '按回车退出'; exit 1 }
if (-not (Test-Path $Reg))  { Line "✗ 找不到注册器：$Reg"; Read-Host '按回车退出'; exit 1 }
if (-not (Test-Path (Join-Path $RepoWork 'package.json'))) {
    Line "✗ 找不到源包：$RepoWork\package.json"; Read-Host '按回车退出'; exit 1
}
if (-not (Test-Path (Join-Path $ProfileDir 'package.json'))) {
    Line "✗ 找不到 profile：$ProfileDir\package.json"; Read-Host '按回车退出'; exit 1
}
Line "✓ 源包：$RepoWork"
Line "✓ profile：$ProfileDir"

# ---- 1. DSH 状态（pnpm install 需要文件不被占用）----
$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessName -like '*DeepSeek*' -or $_.ProcessName -like '*dsh*'
}
if ($procs) {
    Line ''
    Line '⚠ DSH 还在运行。装文件本身可以热加载，但 pnpm install 可能被占用卡住。'
    Line '  建议先完全退出（托盘右键退出），再双击本脚本。'
    $procs | Select-Object ProcessName, Id | Format-Table -AutoSize | Out-String | Write-Host
    $ans = Read-Host '仍要继续吗？输入 y 继续，其它键退出'
    if ($ans -ne 'y') { exit 1 }
}
else { Line '✓ DSH 已退出' }

# ---- 2. 复制插件实体 ----
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bakRoot = Join-Path $RepoWork "backups\pre-install-$stamp"
New-Item -ItemType Directory -Path $bakRoot -Force | Out-Null

if (Test-Path $PluginDir) {
    Line "→ 备份旧插件目录 → $bakRoot\plugins-$PkgName"
    Copy-Item $PluginDir (Join-Path $bakRoot "plugins-$PkgName") -Recurse -Force
}
Line "→ 复制成品（白名单口径）到 $PluginDir"
if (Test-Path $PluginDir) { Remove-Item $PluginDir -Recurse -Force }
New-Item -ItemType Directory -Path $PluginDir -Force | Out-Null
& $Node (Join-Path $RepoWork 'scripts\copy-product.mjs') --from $RepoWork --to $PluginDir --apply
$copyExit = $LASTEXITCODE
if ($copyExit -ne 0) {
    Line "✗ 成品复制失败（退出码 $copyExit：2 = 白名单声明的件在源里缺失；3 = 参数/路径错；4 = IO 失败）。"
    Line ' 这个槽**不可用**（没装全），不要接着做注册/pnpm。'
    Line " 旧版完整备份在上面第 2 步的 $bakRoot —— 可先双击 uninstall-fp.ps1 撤注册，再从备份拷回。"
    Read-Host '按回车退出'; exit 1
}
Line ' ✓ 只装白名单成品（件数与体积见上面 JSON 的 files / productMB）'

# ---- 3. 注册到 profile（交给 node 注册器，带安全闸）----
Head '注册到 profile（register-fp.mjs）'
& $Node $Reg --profile $ProfileDir --plugin $PluginDir
$regExit = $LASTEXITCODE
Line "（注册器退出码 = $regExit）"
if ($regExit -ne 0) {
    Line ''
    Line '✗ 注册失败。原 profile 未被破坏（注册器有安全闸 + 自动回滚）。'
    Line '  把上面的 JSON 输出发给泡泡看。'
    Read-Host '按回车退出'; exit 1
}

# ---- 4. pnpm install ----
Head 'pnpm install（建 node_modules 链接）'
if (-not (Test-Path $Pnpm)) { Line "⚠ 找不到 pnpm：$Pnpm —— 需手动在 $ProfileDir 跑 pnpm install" }
else {
    Push-Location $ProfileDir
    try {
        & $Node $Pnpm install --prefer-offline
        Line "（pnpm 退出码 = $LASTEXITCODE）"
    }
    finally { Pop-Location }
}

# ---- 5. 核对 ----
Head '装载后核对'
$nm = Join-Path $ProfileDir "node_modules\$PkgName"
if (Test-Path $nm) {
    Line '✓ node_modules 链接已建立'
    $item = Get-Item $nm -Force
    if ($item.LinkType) { Line "  LinkType=$($item.LinkType)  Target=$($item.Target)" }
}
else {
    Line '✗ node_modules 链接没建起来 —— 看上面 pnpm 的输出'
    Line '  （常见原因：DSH 没退干净、pnpm 报 lockfile 冲突）'
}

$gate = Join-Path $PluginDir 'engine\verify\tool-surface.mjs'
if (Test-Path $gate) {
    Line ''
    & $Node $gate --dir $PluginDir
    Line "（tool-surface 退出码 = $LASTEXITCODE）"
}
$st = Join-Path $PluginDir 'engine\index.mjs'
if (Test-Path $st) {
    Line ''
    Line '--- engine --selftest ---'
    & $Node $st --selftest
}

Head '完成'
Line '接下来（照 dsh-team 的实测口径）：'
Line '  1) 【别急着重启】新建一个会话，直接调 fp({op:"doctor"})'
Line '     —— 出结果 = 宿主 HMR 已把 profile 树重组好，热加载成功；'
Line '  2) 没反应再完全退出 DSH 重开（托盘右键退出，不是关窗口）——兜底。'
Line ''
Line "插件实体：$PluginDir"
Line "profile：  $ProfileDir\package.json"
Line "备份：     $bakRoot"
Line "回滚：     双击 uninstall-fp.ps1"
Read-Host '按回车关闭'
