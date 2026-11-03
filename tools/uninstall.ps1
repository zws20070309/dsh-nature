# Reverse of install.ps1: unhook the dsh-nature plugin from a DSH profile.
#
# Removals (all idempotent, safe to re-run):
#   1. <DshHome>\profiles\<ProfileName>\package.json             -> - dependencies entry
#                                                                 -> - dsh.profile.bundles entry
#   2. <DshHome>\profiles\<ProfileName>\node_modules\@zws\dsh-nature junction
#   3. <DshHome>\plugins\dsh-nature junction
#
# The plugin's source repository is NEVER touched (junctions are links only).
# The state file <DshHome>\dsh-nature-state.json is kept on purpose: it holds the
# user's config (targetDir/mirror/...) and the skills baseline for a future reinstall.
# package.json is backed up with a timestamped suffix before every modification.
#
# Messages are ASCII on purpose: Windows PowerShell 5.1 parses a BOM-less .ps1 as
# ANSI, and non-ASCII bytes break the tokenizer.
#
# Usage:
#   pwsh -File .\tools\uninstall.ps1
#   pwsh -File .\tools\uninstall.ps1 -DshHome D:\dsh -ProfileName web

param(
    # DSH user-data directory. Default: $env:DSH_HOME, else %USERPROFILE%\.dsh -
    # the same resolution order as the plugin engine (lib/index.js resolveDshHome)
    # and tools\baseline.cjs, matching install.ps1.
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
    # Directory holding this plugin's package.json. Default: the repo root (parent of tools\).
    # Used only to read the package name; may point anywhere (or use -Name).
    [string]$Source = (Split-Path -Parent $PSScriptRoot),
    # Which profile to uninstall from. Default: desktop
    [string]$ProfileName = 'desktop',
    # Fallback package name when <Source>\package.json is gone (e.g. repo deleted first).
    [string]$Name = '@zws/dsh-nature'
)

$ErrorActionPreference = 'Stop'

function Read-Utf8([string]$Path) {
    [System.IO.File]::ReadAllText($Path, (New-Object System.Text.UTF8Encoding $false))
}

# --- resolve the package name ------------------------------------------------------
$pkgName = $Name
$sourcePkg = Join-Path $Source 'package.json'
if (Test-Path -LiteralPath $sourcePkg) {
    $pkg = (Read-Utf8 $sourcePkg | ConvertFrom-Json)
    if ($pkg.name) { $pkgName = $pkg.name }
}
$pluginName = ($pkgName -split '/')[-1]

$profileDir  = Join-Path $DshHome "profiles\$ProfileName"
$profileJson = Join-Path $profileDir 'package.json'
$linkDir     = Join-Path $DshHome "plugins\$pluginName"
$nmJunction  = Join-Path $profileDir "node_modules\$pkgName"

Write-Host "uninstalling: $pkgName from profile '$ProfileName' in $DshHome"

# --- 1. revert the profile package.json --------------------------------------------
# Removal is regex-based on the package name, so it works even if the install used
# a different path or the file was edited by hand afterwards.
if (Test-Path -LiteralPath $profileJson) {
    $raw = Read-Utf8 $profileJson
    $pkgKey = '"' + [regex]::Escape($pkgName) + '"'
    # Value is matched loosely ("[^"]*"), not hardwired to link: - the dep spec may
    # be link:, github:/ or any hand-edited form; only the package NAME anchors.
    # Inline form (what install.ps1 writes into empty collections, all on one line):
    #   "dependencies": { "pkg": "spec" }   /   "bundles": [ "pkg" ]
    $inlineDepRe    = '"dependencies":\s*\{\s*' + $pkgKey + '\s*:\s*"[^"]*"\s*\}'
    $inlineBundleRe = '"bundles":\s*\[\s*' + $pkgKey + '\s*\]'
    $stripped  = [regex]::Replace($raw, $inlineDepRe, '"dependencies": { }')
    $stripped  = [regex]::Replace($stripped, $inlineBundleRe, '"bundles": [ ]')
    # Hand-edited last entry without a trailing comma: drop the comma on the previous
    # line too, or the removal leaves trailing-comma JSON behind (Node rejects it).
    $lastDepRe    = '(?m),[ \t]*\r?\n[ \t]*' + $pkgKey + '\s*:\s*"[^"]*"(?=[ \t]*\r?\n[ \t]*\})'
    $lastBundleRe = '(?m),[ \t]*\r?\n[ \t]*' + $pkgKey + ',?(?=[ \t]*\r?\n[ \t]*\])'
    $stripped  = [regex]::Replace($stripped, $lastDepRe, '')
    $stripped  = [regex]::Replace($stripped, $lastBundleRe, '')
    # Regular line form (the shape install.ps1 writes: own line + trailing comma).
    $depRe    = '(?m)^\s*' + $pkgKey + '\s*:\s*"[^"]*",?\r?\n?'
    $bundleRe = '(?m)^\s*' + $pkgKey + ',?\r?\n?'
    $stripped  = [regex]::Replace($stripped, $depRe, '')
    $stripped  = [regex]::Replace($stripped, $bundleRe, '')
    if ($stripped -ne $raw) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $bak   = "$profileJson.bak-$stamp"
        Copy-Item -LiteralPath $profileJson -Destination $bak -Force
        Write-Host "      backup -> $bak"
        [System.IO.File]::WriteAllText($profileJson, $stripped, (New-Object System.Text.UTF8Encoding $false))
        Write-Host "[1/3] reverted package.json (dependencies + bundles)"
    } else {
        Write-Host "[1/3] package.json has no reference to this package, skipped"
    }
} else {
    Write-Host "[1/3] profile package.json not found, skipped: $profileJson"
}

# --- 2. remove the node_modules junction -------------------------------------------
# -Recurse is required: a junction reports children, and without it Remove-Item
# stops at an interactive confirmation prompt. It removes the link, not the target.
if (Test-Path -LiteralPath $nmJunction) {
    Remove-Item -LiteralPath $nmJunction -Recurse -Force -Confirm:$false
    Write-Host "[2/3] removed junction: $nmJunction"
    # Scoped package leaves an empty scope dir (@zws) behind; drop it if nothing else uses it.
    $scopeDir = Split-Path -Parent $nmJunction
    $scopeName = Split-Path -Leaf $scopeDir
    if ($scopeName -like '@*' -and -not (Get-ChildItem -LiteralPath $scopeDir -Force)) {
        Remove-Item -LiteralPath $scopeDir -Force -Confirm:$false
        Write-Host "      removed empty scope dir: $scopeDir"
    }
} else {
    Write-Host "[2/3] node_modules junction not found, skipped"
}

# --- 3. remove the plugins junction (link only - the repository stays) --------------
if (Test-Path -LiteralPath $linkDir) {
    $existing = Get-Item -LiteralPath $linkDir -Force
    if ($existing.LinkType) {
        Remove-Item -LiteralPath $linkDir -Recurse -Force -Confirm:$false
        Write-Host "[3/3] removed junction: $linkDir (repository untouched)"
    } else {
        Write-Host "[3/3] WARNING: $linkDir is a real directory, not a junction. Left untouched."
    }
} else {
    Write-Host "[3/3] plugins junction not found, skipped"
}

Write-Host ""
Write-Host "UNINSTALL DONE - state file (config + baseline) kept: $(Join-Path $DshHome 'dsh-nature-state.json')"
Write-Host "Fully quit and restart DSH to drop the plugin from the running session."
