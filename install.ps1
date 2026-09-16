<#
.SYNOPSIS
    把 dsh-meal-picker 安装进某个 DSH profile。

.DESCRIPTION
    做的事（每一步都会打印出来）：
      1. 把 package.json 与 cordis.patch.yml 备份到 backup-<时间戳>\（强制，不能跳过）
      2. 把插件目录复制到 <profile>\node_modules\dsh-meal-picker
      3. 往 package.json 的 dependencies 里加一行 file: 依赖（已存在则跳过）
      4. 往 cordis.patch.yml 里加一段 insert（已存在则跳过）
    不做的事：不动 node_modules 里其它包，不重启 DSH，不改全局配置。

.PARAMETER ProfilePath
    DSH profile 目录。默认自动找 ~\.dsh\profiles\web。

.PARAMETER DryRun
    只打印将要做什么，不实际写入。

.EXAMPLE
    .\install.ps1 -DryRun
    .\install.ps1
#>
[CmdletBinding()]
param(
    [string]$ProfilePath = "",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$script:PluginDir = $PSScriptRoot
$script:PluginName = "dsh-meal-picker"

function Say($msg, $color = "Gray") { Write-Host $msg -ForegroundColor $color }

# Windows PowerShell 5.1 的 Get-Content 默认按 ANSI(GBK) 读，会把 UTF-8 里的中文注释读成乱码，
# 再写回去就永久损坏了。所以统一用 .NET 显式 UTF-8，并保留原文件的 BOM 状态。
function Read-TextFile {
    param([string]$Path)
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    if ($hasBom) { $text = $text.Substring(1) }
    # 连行尾风格也记下来，回写时照原样，保证还原是逐字节一致的
    return [pscustomobject]@{
        Text   = $text
        Bom    = $hasBom
        Nl     = $(if ($text.Contains("`r`n")) { "`r`n" } else { "`n" })
        EndsNl = $text.EndsWith("`n")
    }
}

function Join-WithStyle {
    param([string[]]$Lines, $Style)
    $t = ($Lines -join $Style.Nl)
    if ($Style.EndsNl) { $t += $Style.Nl }
    return $t
}

function Write-TextFile {
    param([string]$Path, [string]$Text, [bool]$Bom)
    $enc = New-Object System.Text.UTF8Encoding($Bom)
    [System.IO.File]::WriteAllText($Path, $Text, $enc)
}

function Resolve-Profile {
    param([string]$Explicit)
    if ($Explicit -ne "") {
        if (-not (Test-Path (Join-Path $Explicit "package.json"))) {
            throw "指定目录里没有 package.json：$Explicit"
        }
        return (Resolve-Path $Explicit).Path
    }
    $home_dsh = Join-Path $env:USERPROFILE ".dsh\profiles"
    if (-not (Test-Path $home_dsh)) { return "" }
    $cands = Get-ChildItem $home_dsh -Directory -ErrorAction SilentlyContinue | Where-Object {
        Test-Path (Join-Path $_.FullName "package.json")
    }
    if ($cands.Count -eq 0) { return "" }
    # 有 cordis.patch.yml 的那个优先（DSH Desktop 的 web profile 就是这个）
    $preferred = $cands | Where-Object { Test-Path (Join-Path $_.FullName "cordis.patch.yml") }
    if ($preferred) { return $preferred[0].FullName }
    return $cands[0].FullName
}

$profile = Resolve-Profile -Explicit $ProfilePath
if ($profile -eq "") {
    Say "✗ 没找到 DSH profile 目录。" "Red"
    Say "  请用 -ProfilePath 指定，例如：" "Yellow"
    Say "    .\install.ps1 -ProfilePath `"$env:USERPROFILE\.dsh\profiles\web`"" "Yellow"
    exit 1
}

Say "== dsh-meal-picker 安装 ==" "Cyan"
Say "  插件目录 : $script:PluginDir"
Say "  profile  : $profile"
if ($DryRun) { Say "  模式     : 预演（不会写入任何文件）" "Yellow" }
Say ""

$pkgFile = Join-Path $profile "package.json"
$patchFile = Join-Path $profile "cordis.patch.yml"

# ---------------------------------------------------------------- 备份
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = Join-Path $profile "backup-$stamp"
if (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    Copy-Item $pkgFile (Join-Path $backupDir "package.json") -Force
    if (Test-Path $patchFile) { Copy-Item $patchFile (Join-Path $backupDir "cordis.patch.yml") -Force }
    Say "[1/4] 已备份到 $backupDir" "Green"
} else {
    Say "[1/4] 会备份 package.json 与 cordis.patch.yml 到 backup-$stamp\" "Gray"
}

# ---------------------------------------------------------------- 复制插件
$target = Join-Path $profile "node_modules\$script:PluginName"
if (-not $DryRun) {
    if (Test-Path $target) { Remove-Item $target -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    foreach ($item in @("lib", "data", "assets", "package.json", "cordis.patch.yml", "README.md", "CHANGELOG.md", "LICENSE")) {
        $src = Join-Path $script:PluginDir $item
        if (Test-Path $src) { Copy-Item $src (Join-Path $target $item) -Recurse -Force }
    }
    Say "[2/4] 插件已复制到 $target" "Green"
} else {
    Say "[2/4] 会复制 lib\ data\ package.json 等到 $target" "Gray"
}

# ---------------------------------------------------------------- 改 package.json
$pkgRead = Read-TextFile -Path $pkgFile
$pkg = $pkgRead.Text | ConvertFrom-Json
$depValue = "file:./node_modules/$script:PluginName"
$hasDep = $null -ne $pkg.dependencies.PSObject.Properties[$script:PluginName]
if ($hasDep) {
    Say "[3/4] package.json 里已有依赖，跳过" "Yellow"
} else {
    if (-not $DryRun) {
        $pkg.dependencies | Add-Member -NotePropertyName $script:PluginName -NotePropertyValue $depValue -Force
        $json = $pkg | ConvertTo-Json -Depth 32
        if ($pkgRead.Nl -eq "`n") { $json = $json -replace "`r`n", "`n" }
        if ($pkgRead.EndsNl) { $json += $pkgRead.Nl }
        Write-TextFile -Path $pkgFile -Text $json -Bom $pkgRead.Bom
        Say "[3/4] 已往 package.json 加依赖：$script:PluginName -> $depValue" "Green"
    } else {
        Say "[3/4] 会往 package.json 加依赖：$script:PluginName -> $depValue" "Gray"
    }
}

# ---------------------------------------------------------------- 改 cordis.patch.yml
$insertBlock = @(
    "- insert:",
    "    - id: meal-picker",
    "      name: '$script:PluginName'",
    "      config:",
    "        city: ''",
    "        scene: cook",
    "        foreign: any",
    "        avoid: ''",
    "        count: 5",
    "        recentLimit: 12"
)

$patchRead = if (Test-Path $patchFile) { Read-TextFile -Path $patchFile } else { [pscustomobject]@{ Text = ""; Bom = $false; Nl = "`n"; EndsNl = $true } }
$patchRaw = $patchRead.Text
if ($patchRaw -match "meal-picker") {
    Say "[4/4] cordis.patch.yml 里已有 meal-picker，跳过" "Yellow"
} else {
    if (-not $DryRun) {
        $lines = if ($patchRaw -eq "") { @() } else { @($patchRaw -split "`r?`n") }
        while ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq "") {
            $lines = @($lines[0..($lines.Count - 2)])
        }
        # 找第一条非注释、非空的内容行
        $contentIdx = -1
        for ($i = 0; $i -lt $lines.Count; $i++) {
            $t = $lines[$i].Trim()
            if ($t -ne "" -and -not $t.StartsWith("#")) { $contentIdx = $i; break }
        }
        if ($contentIdx -ge 0 -and $lines[$contentIdx].Trim() -eq "[]") {
            # 空数组 -> 直接替换那一行
            $new = @()
            if ($contentIdx -gt 0) { $new += $lines[0..($contentIdx - 1)] }
            $new += $insertBlock
            if ($contentIdx -lt $lines.Count - 1) { $new += $lines[($contentIdx + 1)..($lines.Count - 1)] }
            Write-TextFile -Path $patchFile -Text (Join-WithStyle -Lines $new -Style $patchRead) -Bom $patchRead.Bom
            Say "[4/4] cordis.patch.yml 原本是空数组，已替换为 insert 块" "Green"
        } else {
            # 已有内容 -> 追加到末尾
            $new = @($lines) + @("") + $insertBlock
            Write-TextFile -Path $patchFile -Text (Join-WithStyle -Lines $new -Style $patchRead) -Bom $patchRead.Bom
            Say "[4/4] 已把 insert 块追加到 cordis.patch.yml 末尾" "Green"
        }
    } else {
        Say "[4/4] 会往 cordis.patch.yml 加一段 insert（id: meal-picker）" "Gray"
    }
}

Say ""
if ($DryRun) {
    Say "预演结束，没有改动任何文件。去掉 -DryRun 即可真正安装。" "Yellow"
} else {
    Say "安装完成。" "Cyan"
    Say ""
    Say "下一步：**重启 DSH Desktop**，然后在对话输入框左边就能看到 🍚「今天吃什么」。" "White"
    Say ""
    Say "想还原：跑 .\uninstall.ps1" "Gray"
    Say "手工还原：把 $backupDir 里的两个文件拷回 $profile 即可" "Gray"
}
