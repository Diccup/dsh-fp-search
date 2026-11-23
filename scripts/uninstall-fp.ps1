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
# dsh-fp-search 卸载脚本（由维护方双击运行）— v2
#
# 做三件事（对应装载时的三处，少撤一处就会残留注册）：
#   1. 从 profile 的 package.json 里撤掉 dependencies 与 bundles 两处
#   2. 在 profile 目录跑 pnpm install（清掉 node_modules 链接）
#   3. 删除 %USERPROFILE%\.dsh\plugins\dsh-fp-search
#
# 备份（work\backups\pre-install-*）不删，需要回滚旧版时手动拷回。

$ErrorActionPreference = 'Stop'
try { chcp 65001 | Out-Null } catch {}

$PkgName = 'dsh-fp-search'
$PluginDir  = Join-Path $env:USERPROFILE ".dsh\plugins\$PkgName"

# ★ 发布版可移植化（2026-11-16）：原先写死 `C:\Users\Diccup\...` 和 profile 名 `desktop`。
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
$ProfilePkg = Join-Path $ProfileDir 'package.json'

Write-Host ''
Write-Host ('=' * 62)
Write-Host "FP 卸载 · $PkgName"
Write-Host ('=' * 62)

$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessName -like '*DeepSeek*' -or $_.ProcessName -like '*dsh*'
}
if ($procs) {
    Write-Host '⚠ DSH 还在运行。建议完全退出后再卸载（托盘右键退出）。'
    $ans = Read-Host '仍要继续吗？输入 y 继续，其它键退出'
    if ($ans -ne 'y') { exit 1 }
}

# ---- 1. 改 profile package.json ----
if (Test-Path $ProfilePkg) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $bak = "$ProfilePkg.bak-before-uninstall-fp-$stamp"
    Copy-Item $ProfilePkg $bak -Force
    Write-Host "→ 备份 profile → $bak"

    $json = Get-Content -LiteralPath $ProfilePkg -Raw | ConvertFrom-Json
    $changed = @()

    if ($json.dependencies.PSObject.Properties.Name.Contains($PkgName)) {
        $json.dependencies.PSObject.Properties.Remove($PkgName)
        $changed += "dependencies -= $PkgName"
    }
    $bundles = @($json.dsh.profile.bundles) | Where-Object { $_ -ne $PkgName }
    if ($bundles.Count -ne @($json.dsh.profile.bundles).Count) {
        $json.dsh.profile.bundles = $bundles
        $changed += "dsh.profile.bundles -= $PkgName"
    }

    if ($changed.Count -eq 0) { Write-Host '  － 两处注册本来就没有，无需改' }
    else {
        foreach ($c in $changed) { Write-Host "  ✓ $c" }
        $out = $json | ConvertTo-Json -Depth 20
        [System.IO.File]::WriteAllText($ProfilePkg, $out + "`n", (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "  ✓ 已写回 $ProfilePkg"
    }
}
else { Write-Host "－ 找不到 profile：$ProfilePkg" }

# ---- 2. pnpm install ----
if ((Test-Path $Node) -and (Test-Path $Pnpm)) {
    Write-Host ''
    Write-Host '→ pnpm install（清链接）'
    Push-Location $ProfileDir
    try { & $Node $Pnpm install --prefer-offline; Write-Host "（pnpm 退出码 = $LASTEXITCODE）" }
    finally { Pop-Location }
}

# ---- 3. 删插件实体 ----
if (Test-Path $PluginDir) {
    $n = (Get-ChildItem $PluginDir -Recurse -File).Count
    Remove-Item $PluginDir -Recurse -Force
    Write-Host "✓ 已删除 $PluginDir（$n 件）"
}
else { Write-Host "－ 不存在，跳过：$PluginDir" }

Write-Host ''
Write-Host '完成。新开一个会话就不该再看见 fp 工具了。'
Read-Host '按回车关闭'
