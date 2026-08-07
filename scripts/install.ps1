# Installs mu from GitHub Releases -- no npm, no Bun. Downloads
# mu-windows-x64.zip, verifies it against the published SHA256SUMS, and unpacks
# it into $env:USERPROFILE\.mu (executable at .mu\bin\mu.exe).
#
# Usage: irm https://raw.githubusercontent.com/Spandan7724/mu/main/scripts/install.ps1 | iex

$ErrorActionPreference = "Stop"

$Repo = "Spandan7724/mu"
$MuRoot = Join-Path $env:USERPROFILE ".mu"
$InstallDir = Join-Path $MuRoot "bin"
$BinName = "mu.exe"
$ReceiptName = ".mu-install.json"
$Target = "windows-x64"
$Asset = "mu-windows-x64.zip"
# Replaced wholesale on install; everything else in .mu is user state.
$OwnedEntries = @("mu-path", "licenses", "mu-package.json")

function Die($Message) {
    # Not `exit` -- when this script runs via the documented `irm | iex`
    # pipeline, `exit` would close the user's entire PowerShell session, not
    # just this script. `throw` is a terminating error that unwinds cleanly
    # (running any enclosing `finally` blocks first) without touching the host.
    throw $Message
}

# Only x64 is published today (see scripts/package-release.ts RELEASE_SPECS).
$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
if ($arch -ne [System.Runtime.InteropServices.Architecture]::X64) {
    Die "unsupported architecture ($arch). Download a build manually from https://github.com/$Repo/releases/latest"
}

# Resolve the latest release tag by following the redirect GitHub serves for
# /releases/latest -> /releases/tag/<tag>. Invoke-WebRequest's follow-redirect
# behavior is standard on both Windows PowerShell 5.1 and PowerShell 7, but
# the two editions expose the final resolved URL through different
# BaseResponse properties (HttpWebResponse.ResponseUri on 5.1 vs.
# HttpResponseMessage.RequestMessage.RequestUri on 7), so check for both
# rather than assuming one.
try {
    $latestResponse = Invoke-WebRequest -Uri "https://github.com/$Repo/releases/latest" `
        -MaximumRedirection 10 -UseBasicParsing
} catch {
    Die "could not resolve the latest release (does $Repo have any releases?)"
}
$finalUri = $null
if ($latestResponse.BaseResponse.PSObject.Properties.Name -contains "ResponseUri") {
    $finalUri = $latestResponse.BaseResponse.ResponseUri
} elseif ($latestResponse.BaseResponse.PSObject.Properties.Name -contains "RequestMessage") {
    $finalUri = $latestResponse.BaseResponse.RequestMessage.RequestUri
}
if ($null -eq $finalUri) {
    Die "could not resolve the latest release tag"
}
$tag = $finalUri.Segments[-1].TrimEnd("/")
$version = $tag -replace "^v", ""

Write-Host "Installing mu $version ($Target)..."

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# Staged inside .mu so the final moves are same-volume renames.
$staging = Join-Path $MuRoot ".install.$PID"
New-Item -ItemType Directory -Force -Path $staging | Out-Null
$tempSums = Join-Path $staging "SHA256SUMS"
$archivePath = Join-Path $staging $Asset
$extractDir = Join-Path $staging "extract"

try {
    try {
        Invoke-WebRequest -Uri "https://github.com/$Repo/releases/download/$tag/SHA256SUMS" -OutFile $tempSums -UseBasicParsing
    } catch {
        Die "could not download SHA256SUMS for $tag"
    }

    $sumsLine = Select-String -Path $tempSums -Pattern "  $Asset$" | Select-Object -First 1
    if ($null -eq $sumsLine) {
        Die "SHA256SUMS does not list a digest for $Asset"
    }
    $expected = ($sumsLine.Line -split "\s+")[0].ToLowerInvariant()

    try {
        Invoke-WebRequest -Uri "https://github.com/$Repo/releases/download/$tag/$Asset" -OutFile $archivePath -UseBasicParsing
    } catch {
        Die "could not download $Asset"
    }

    $actual = (Get-FileHash -Path $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        Die "checksum mismatch for ${Asset}: expected $expected, got $actual"
    }

    # ZipFile rather than Expand-Archive: markedly faster on a ~38 MB archive.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    try {
        [System.IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $extractDir)
    } catch {
        Die "could not extract ${Asset}: $($_.Exception.Message)"
    }

    $staged = Join-Path $extractDir "mu-$Target"
    $stagedBinary = Join-Path $staged "bin\$BinName"
    if (-not (Test-Path -Path $stagedBinary -PathType Leaf)) {
        Die "$Asset did not contain mu-$Target\bin\$BinName"
    }

    foreach ($entry in $OwnedEntries) {
        $source = Join-Path $staged $entry
        if (Test-Path -Path $source) {
            $destination = Join-Path $MuRoot $entry
            Remove-Item -Path $destination -Recurse -Force -ErrorAction SilentlyContinue
            Move-Item -Path $source -Destination $destination -Force
        }
    }

    Move-Item -Path $stagedBinary -Destination (Join-Path $InstallDir $BinName) -Force

    $receiptPath = Join-Path $InstallDir $ReceiptName
    [System.IO.File]::WriteAllText($receiptPath, "{`"method`":`"github-release`",`"target`":`"$Target`"}")
} finally {
    Remove-Item -Path $staging -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Installed mu $version to $(Join-Path $InstallDir $BinName)"

# --- PATH -------------------------------------------------------------

$userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
$alreadyOnPath = ($userPath -split ";") -contains $InstallDir
if (-not $alreadyOnPath) {
    $newUserPath = if ([string]::IsNullOrEmpty($userPath)) { $InstallDir } else { "$InstallDir;$userPath" }
    [Environment]::SetEnvironmentVariable("PATH", $newUserPath, "User")
    # Also update the current session so 'mu' works without reopening the shell.
    $env:PATH = "$InstallDir;$env:PATH"
    Write-Host "Added $InstallDir to your User PATH. Open a new terminal for it to apply everywhere."
}

Write-Host ""
Write-Host "Run 'mu --version' to verify. 'mu self update' keeps this install current."
