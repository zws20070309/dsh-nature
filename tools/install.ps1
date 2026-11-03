# Wire the dsh-nature plugin into a DSH profile (no file copies; junction + link: dep).
#
# Changes (all idempotent, safe to re-run):
#   1. <DshHome>\plugins\dsh-nature                              -> junction to -Source
#   2. <DshHome>\profiles\<ProfileName>\package.json             -> + dependencies entry
#                                                                 -> + dsh.profile.bundles entry
#   3. <DshHome>\profiles\<ProfileName>\node_modules\@zws\dsh-nature -> junction
#   4. optional (with -CloneDir): node tools\baseline.cjs <clone> <state>
#
# package.json is backed up with a timestamped suffix right before every modification.
# Junctions are used instead of symbolic links on purpose: a junction needs no
# administrator rights (the reference install-link.ps1 does the same).
#
# Messages are ASCII on purpose: Windows PowerShell 5.1 parses a BOM-less .ps1 as
# ANSI, and non-ASCII bytes break the tokenizer.
#
# Usage:
#   pwsh -File .\tools\install.ps1
#   pwsh -File .\tools\install.ps1 -CloneDir D:\path\to\nature-skills-clone
#   pwsh -File .\tools\install.ps1 -DshHome D:\dsh -ProfileName web -Source D:\repo\dsh-nature

param(
    # DSH user-data directory. Default: $env:DSH_HOME, else %USERPROFILE%\.dsh -
    # the same resolution order as the plugin engine (lib/index.js resolveDshHome)
    # and tools\baseline.cjs. Otherwise the baseline state file lands in the wrong
    # home and the plugin reports baseline-missing forever.
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
    # Directory holding this plugin's package.json. Default: the repo root (parent of tools\).
    [string]$Source = (Split-Path -Parent $PSScriptRoot),
    # Which profile to install into. Default: desktop
    [string]$ProfileName = 'desktop',
    # Optional local clone of Yuan1z0825/nature-skills. When given, the skills
    # baseline is built right after wiring (offline, via git ls-tree).
    [string]$CloneDir = ''
)

$ErrorActionPreference = 'Stop'

# --- resolve everything from the parameters --------------------------------------
$sourcePkg = Join-Path $Source 'package.json'
if (-not (Test-Path -LiteralPath $sourcePkg)) {
    throw "No package.json in: $Source`nUse -Source <plugin directory>."
}
# Read as UTF-8 explicitly: Windows PowerShell 5.1 defaults to ANSI, which mangles
# any non-ASCII byte and breaks JSON parsing.
function Read-Utf8([string]$Path) {
    [System.IO.File]::ReadAllText($Path, (New-Object System.Text.UTF8Encoding $false))
}
$pkg = (Read-Utf8 $sourcePkg | ConvertFrom-Json)
if (-not $pkg.name) { throw "package.json has no 'name' field: $sourcePkg" }

$pkgName    = $pkg.name                       # e.g. @zws/dsh-nature
$pluginName = ($pkgName -split '/')[-1]       # e.g. dsh-nature

$dshPlugins  = Join-Path $DshHome 'plugins'
$profileDir  = Join-Path $DshHome "profiles\$ProfileName"
$profileJson = Join-Path $profileDir 'package.json'
$linkDir     = Join-Path $dshPlugins $pluginName
$nmJunction  = Join-Path $profileDir "node_modules\$pkgName"

# npm expects forward slashes in a link: spec
$depSpec     = 'link:' + ($linkDir -replace '\\', '/')
$depEntry    = '"' + $pkgName + '": "' + $depSpec + '"'
$depLine     = '    ' + $depEntry + ','
$bundleEntry = '"' + $pkgName + '"'
$bundleLine  = '        ' + $bundleEntry + ','

if (-not (Test-Path -LiteralPath $profileJson)) {
    throw "Profile not found: $profileJson`nUse -DshHome / -ProfileName to point at a real profile."
}

# --- 0. source sanity: both plugin halves must be there ---------------------------
if (-not (Test-Path -LiteralPath (Join-Path $Source 'lib/index.js'))) {
    throw "Cannot find lib\index.js in: $Source"
}
if (-not (Test-Path -LiteralPath (Join-Path $Source 'lib/client.js'))) {
    throw "Cannot find lib\client.js in: $Source"
}
Write-Host "[0/4] source OK: $Source  ($pkgName)"

# --- 1. plugins\<name> junction ---------------------------------------------------
if (Test-Path -LiteralPath $linkDir) {
    $existing = Get-Item -LiteralPath $linkDir -Force
    if ($existing.LinkType) {
        Write-Host "[1/4] plugins junction already exists -> $($existing.Target -join ';')"
    } else {
        Write-Host "[1/4] WARNING: $linkDir exists but is a real directory, not a junction. Left untouched."
    }
} else {
    New-Item -ItemType Junction -Path $linkDir -Target $Source | Out-Null
    Write-Host "[1/4] created junction: $linkDir -> $Source"
}

# --- 2/3. insert into the profile package.json ------------------------------------
# Insertion anchors on the JSON keys themselves, NOT on any other plugin's line.
# Empty collections ("dependencies": {} / "bundles": [], braces on one line or not)
# get an INLINE entry instead of a new line: a line insert after "{" would end in a
# comma right before the closing bracket - trailing-comma JSON that Node rejects
# (pwsh 7's ConvertFrom-Json tolerates it, which is exactly how a corrupted profile
# used to slip through VERIFY).
# Backup with a timestamped suffix is taken right before the first actual write.
$raw     = Read-Utf8 $profileJson
$changed = $false

if ($raw -match '"' + [regex]::Escape($pkgName) + '"') {
    Write-Host "[2/4] package.json already references this package, skipped"
} else {
    $depAnchor = '"dependencies": {'
    if ($raw -notmatch [regex]::Escape($depAnchor)) {
        throw "No `"dependencies`" block in $profileJson. Nothing was modified."
    }
    $bundleAnchor = '"bundles": ['
    if ($raw -notmatch [regex]::Escape($bundleAnchor)) {
        throw "No dsh.profile.bundles array in $profileJson. Nothing was modified."
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $bak   = "$profileJson.bak-$stamp"
    Copy-Item -LiteralPath $profileJson -Destination $bak -Force
    Write-Host "      backup -> $bak"

    # Instance Replace with an explicit count of 1: on the static [regex]::Replace
    # overload that 4th argument is RegexOptions, so "1" meant IgnoreCase and EVERY
    # matching anchor got an entry, not just the first one.
    # MatchEvaluator scriptblocks (not string replacements) so "$" in paths stays literal.
    if ([regex]::IsMatch($raw, [regex]::Escape($depAnchor) + '\s*\}')) {
        $raw = [regex]::new([regex]::Escape($depAnchor) + '\s*\}').Replace($raw, { param($m) $depAnchor + ' ' + $depEntry + ' }' }, 1)
    } else {
        $raw = [regex]::new([regex]::Escape($depAnchor)).Replace($raw, { param($m) $m.Value + "`n" + $depLine }, 1)
    }
    if ([regex]::IsMatch($raw, [regex]::Escape($bundleAnchor) + '\s*\]')) {
        $raw = [regex]::new([regex]::Escape($bundleAnchor) + '\s*\]').Replace($raw, { param($m) $bundleAnchor + ' ' + $bundleEntry + ' ]' }, 1)
    } else {
        $raw = [regex]::new([regex]::Escape($bundleAnchor)).Replace($raw, { param($m) $m.Value + "`n" + $bundleLine }, 1)
    }
    $changed = $true
    Write-Host "[2/4] dependencies entry inserted"
    Write-Host "[3/4] dsh.profile.bundles entry inserted"
}

if ($changed) {
    [System.IO.File]::WriteAllText($profileJson, $raw, (New-Object System.Text.UTF8Encoding $false))
}

# --- 4. node_modules junction (link: dep must be resolvable without npm install) ---
if (Test-Path -LiteralPath $nmJunction) {
    Write-Host "[4/4] node_modules junction already exists, skipped"
} else {
    $nmParent = Split-Path -Parent $nmJunction
    if (-not (Test-Path -LiteralPath $nmParent)) { New-Item -ItemType Directory -Path $nmParent -Force | Out-Null }
    New-Item -ItemType Junction -Path $nmJunction -Target $linkDir | Out-Null
    Write-Host "[4/4] created junction: $nmJunction -> $linkDir"
}

# --- verify ------------------------------------------------------------------------
Write-Host ""
Write-Host "==== VERIFY ===="
$j = Get-Item -LiteralPath $nmJunction -Force
Write-Host ("node_modules LinkType : " + $j.LinkType)
Write-Host ("node_modules Target   : " + ($j.Target -join ';'))

$check     = Read-Utf8 $profileJson | ConvertFrom-Json
$hasDep    = $null -ne $check.dependencies.PSObject.Properties[$pkgName]
$hasBundle = @($check.dsh.profile.bundles) -contains $pkgName
Write-Host ("dependencies has pkg  : " + $hasDep)
Write-Host ("bundles has pkg       : " + $hasBundle)
Write-Host ("client.js visible     : " + (Test-Path -LiteralPath (Join-Path $nmJunction 'lib/client.js')))

# Strict JSON check: pwsh 7's ConvertFrom-Json tolerates trailing commas, so the
# loose parse above cannot be trusted alone. Node's JSON.parse is the exact engine
# DSH loads profiles with - run it whenever node is on PATH.
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    & node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); console.log('profile.json strict JSON.parse: OK')" $profileJson
    if ($LASTEXITCODE -ne 0) {
        throw "profile package.json is not strictly valid JSON (see node error above)"
    }
} else {
    Write-Host "profile.json strict parse: skipped (node not on PATH)"
}

# --- optional: build the skills baseline from a local clone ------------------------
if ($CloneDir -ne '') {
    $baseline  = Join-Path $PSScriptRoot 'baseline.cjs'
    $statePath = Join-Path $DshHome 'dsh-nature-state.json'
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $node) {
        Write-Warning "node not found on PATH; run later: node `"$baseline`" `"$CloneDir`" `"$statePath`""
    } else {
        & node $baseline $CloneDir $statePath
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "baseline.cjs failed (exit $LASTEXITCODE) - plugin is wired, run baseline again later."
        }
    }
} else {
    Write-Host "[baseline] -CloneDir not given: run baseline.cjs later to build the skills baseline."
}

if ($hasDep -and $hasBundle) {
    Write-Host ""
    Write-Host "INSTALL OK - fully quit and restart DSH for this to take effect (no HMR)."
} else {
    Write-Host ""
    Write-Host "INSTALL INCOMPLETE - see any False above."
    exit 1
}
