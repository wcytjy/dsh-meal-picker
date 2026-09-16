<#
.SYNOPSIS
    把 dsh-meal-picker 从 DSH profile 里卸干净。

.DESCRIPTION
    做的事：
      1. 备份当前 package.json 与 cordis.patch.yml
      2. 从 package.json 删掉 dsh-meal-picker 依赖
      3. 从 cordis.patch.yml 删掉对应的 insert 块
      4. 删掉 node_modules\dsh-meal-picker
    做完重启 DSH 即可，界面回到安装前的样子。

.PARAMETER ProfilePath
    DSH profile 目录。默认自动找 ~\.dsh\profiles\web。

.PARAMETER KeepFiles
    只改配置、不删 node_modules 里的插件目录。

.EXAMPLE
    .\uninstall.ps1
#>
[CmdletBinding()]
param(
    [string]$ProfilePath = "",
    [switch]$KeepFiles
)

$ErrorActionPreference = "Stop"
$script:PluginName = "dsh-meal-picker"

function Say($msg, $color = "Gray") { Write-Host $msg -ForegroundColor $color }

# Windows PowerShell 5.1 的 Get-Content 默认按 ANSI(GBK) 读，会把 UTF-8 里的中文注释读成乱码，
# 再写回去就永久损坏了（cordis.patch.yml 里就有中文注释）。统一用 .NET 显式 UTF-8。
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
    $preferred = $cands | Where-Object { Test-Path (Join-Path $_.FullName "cordis.patch.yml") }
    if ($preferred) { return $preferred[0].FullName }
    if ($cands.Count -gt 0) { return $cands[0].FullName }
    return ""
}

$profile = Resolve-Profile -Explicit $ProfilePath
if ($profile -eq "") {
    Say "✗ 没找到 DSH profile 目录，请用 -ProfilePath 指定。" "Red"
    exit 1
}

Say "== dsh-meal-picker 卸载 ==" "Cyan"
Say "  profile : $profile"
Say ""

$pkgFile = Join-Path $profile "package.json"
$patchFile = Join-Path $profile "cordis.patch.yml"

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = Join-Path $profile "backup-uninstall-$stamp"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
Copy-Item $pkgFile (Join-Path $backupDir "package.json") -Force
if (Test-Path $patchFile) { Copy-Item $patchFile (Join-Path $backupDir "cordis.patch.yml") -Force }
Say "[1/4] 已备份到 $backupDir" "Green"

# ---- package.json ----
$pkgRead = Read-TextFile -Path $pkgFile
$pkg = $pkgRead.Text | ConvertFrom-Json
if ($null -ne $pkg.dependencies.PSObject.Properties[$script:PluginName]) {
    $pkg.dependencies.PSObject.Properties.Remove($script:PluginName)
    $json = $pkg | ConvertTo-Json -Depth 32
    if ($pkgRead.Nl -eq "`n") { $json = $json -replace "`r`n", "`n" }
    if ($pkgRead.EndsNl) { $json += $pkgRead.Nl }
    Write-TextFile -Path $pkgFile -Text $json -Bom $pkgRead.Bom
    Say "[2/4] 已从 package.json 删除依赖" "Green"
} else {
    Say "[2/4] package.json 里没有该依赖，跳过" "Yellow"
}

# ---- cordis.patch.yml ----
# 按索引遍历：一个顶层项从第 0 列开始（"- insert:"），后续缩进行都属于它。
if (Test-Path $patchFile) {
    $patchRead = Read-TextFile -Path $patchFile
    $lines = @($patchRead.Text -split "`r?`n")
    while ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq "") {
        $lines = @($lines[0..($lines.Count - 2)])
    }
    $out = New-Object System.Collections.Generic.List[string]
    $removed = 0
    $i = 0
    while ($i -lt $lines.Count) {
        $raw = $lines[$i]
        if ($raw.Trim() -eq "- insert:") {
            $j = $i + 1
            while ($j -lt $lines.Count) {
                $cand = $lines[$j]
                $ct = $cand.Trim()
                $indented = $cand.StartsWith(" ") -or $cand.StartsWith("`t")
                if ($ct -ne "" -and -not $indented) { break }
                $j++
            }
            $block = if ($j -gt $i) { ($lines[$i..($j - 1)] -join "`n") } else { $raw }
            if ($block -match $script:PluginName) {
                $removed++
            } else {
                for ($k = $i; $k -lt $j; $k++) { $out.Add($lines[$k]) }
            }
            $i = $j
            continue
        }
        $out.Add($raw)
        $i++
    }
    if ($removed -gt 0) {
        # 只剩注释和空行时补一个空数组，避免 YAML 变成 null
        $hasContent = @($out | Where-Object {
            $tt = $_.Trim()
            $tt -ne "" -and -not $tt.StartsWith("#")
        }).Count -gt 0
        $final = @($out)
        if (-not $hasContent) { $final += "[]" }
        Write-TextFile -Path $patchFile -Text (Join-WithStyle -Lines $final -Style $patchRead) -Bom $patchRead.Bom
        Say "[3/4] 已从 cordis.patch.yml 移除 $removed 个 insert 块" "Green"
    } else {
        Say "[3/4] cordis.patch.yml 里没有该插件，跳过" "Yellow"
    }
} else {
    Say "[3/4] 没有 cordis.patch.yml，跳过" "Yellow"
}

# ---- node_modules ----
$target = Join-Path $profile "node_modules\$script:PluginName"
if ($KeepFiles) {
    Say "[4/4] -KeepFiles：保留 $target" "Yellow"
} elseif (Test-Path $target) {
    Remove-Item $target -Recurse -Force
    Say "[4/4] 已删除 $target" "Green"
} else {
    Say "[4/4] 插件目录不存在，跳过" "Yellow"
}

Say ""
Say "卸载完成。**重启 DSH Desktop** 后界面就回到安装前的样子。" "Cyan"
Say "如果出问题，把 $backupDir 里的两个文件拷回 $profile 即可还原。" "Gray"
