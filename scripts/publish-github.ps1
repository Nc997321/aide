# Windows host entry point. All history rewriting/scanning/pushing stays in the
# existing publish-github.sh; this wrapper locates host tools and optionally uploads
# a GitHub Release after the sanitized tag has been pushed.
[CmdletBinding()]
param(
    [switch]$DryRun,
    [string[]]$Tag = @(),
    [switch]$Force,
    [string]$ReleaseTag,
    [string[]]$Asset = @(),
    [string]$NotesFile
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$gitExe = (Get-Command git.exe -ErrorAction Stop).Source
$gitRoot = Split-Path (Split-Path $gitExe -Parent) -Parent
$gitBash = Join-Path $gitRoot 'bin/bash.exe'
if (-not (Test-Path -LiteralPath $gitBash)) {
    throw 'Git Bash not found. Install Git for Windows to run the mirror publisher.'
}

$previousPath = $env:PATH
$previousRemote = $env:AIDE_PUBLISH_REMOTE
$previousHttpProxy = $env:HTTP_PROXY
$previousHttpsProxy = $env:HTTPS_PROXY
Push-Location $repoRoot
try {
    # pip --user executables need not be added to the machine-wide PATH.
    $pythonScripts = & python -c "import sysconfig; print(sysconfig.get_path('scripts', scheme='nt_user'))"
    if ($LASTEXITCODE -ne 0) { throw 'Python is required for git-filter-repo.' }
    $env:PATH = "$pythonScripts;$env:PATH"
    $ghDirectory = Join-Path $env:ProgramFiles 'GitHub CLI'
    if (Test-Path -LiteralPath $ghDirectory) { $env:PATH = "$ghDirectory;$env:PATH" }
    # Git/gh do not automatically use WinINET's proxy. Follow the user's existing
    # Windows settings for this process only; never save proxy addresses in Git.
    $proxySettings = Get-ItemProperty 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Internet Settings' -ErrorAction SilentlyContinue
    if (-not $env:HTTPS_PROXY -and $proxySettings.ProxyEnable -eq 1 -and $proxySettings.ProxyServer) {
        $proxy = [string]$proxySettings.ProxyServer
        if ($proxy -match '(?:^|;)https=([^;]+)') { $proxy = $matches[1] }
        elseif ($proxy -match '(?:^|;)http=([^;]+)') { $proxy = $matches[1] }
        if ($proxy -notmatch '^https?://') { $proxy = "http://$proxy" }
        $env:HTTPS_PROXY = $proxy
        if (-not $env:HTTP_PROXY) { $env:HTTP_PROXY = $proxy }
    }
    if (-not $env:AIDE_PUBLISH_REMOTE) {
        $remoteUrl = & git remote get-url github
        if ($LASTEXITCODE -ne 0) { throw 'Configure the github remote or set AIDE_PUBLISH_REMOTE first.' }
        $env:AIDE_PUBLISH_REMOTE = $remoteUrl.Trim()
    }
    if ($ReleaseTag) {
        if (-not $Asset.Count -or -not $NotesFile) { throw 'ReleaseTag requires Asset and NotesFile.' }
        foreach ($file in @($Asset) + @($NotesFile)) {
            if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Release file not found: $file" }
        }
        Get-Command gh -ErrorAction Stop | Out-Null
        if (-not $DryRun) {
            & gh auth status --hostname github.com
            if ($LASTEXITCODE -ne 0) { throw 'Sign in on the Windows host with gh auth login first.' }
        }
        if ($ReleaseTag -notin $Tag) { $Tag += $ReleaseTag }
    }
    $scriptArgs = @()
    if ($DryRun) { $scriptArgs += '--dry-run' }
    if ($Force) { $scriptArgs += '--force' }
    foreach ($versionTag in $Tag) { $scriptArgs += @('--tag', $versionTag) }
    $script = (Join-Path $PSScriptRoot 'publish-github.sh').Replace('\', '/')
    & $gitBash $script @scriptArgs
    if ($LASTEXITCODE -ne 0) { throw "GitHub mirror publisher failed (exit $LASTEXITCODE)." }
    if ($ReleaseTag -and -not $DryRun) {
        # Keep incomplete uploads private as a draft; only publish after every
        # expected asset exists with the local file's byte length.
        $releaseJson = & gh release view $ReleaseTag --repo $env:AIDE_PUBLISH_REMOTE --json isDraft,assets 2>$null
        if ($LASTEXITCODE -eq 0) {
            $release = $releaseJson | ConvertFrom-Json
            if (-not $release.isDraft) { throw "Release $ReleaseTag is already published; refusing to overwrite it." }
            & gh release edit $ReleaseTag --repo $env:AIDE_PUBLISH_REMOTE --title "Aide $ReleaseTag" --notes-file $NotesFile
            if ($LASTEXITCODE -ne 0) { throw 'Failed to update draft release.' }
        } else {
            & gh release create $ReleaseTag --repo $env:AIDE_PUBLISH_REMOTE --verify-tag --draft --title "Aide $ReleaseTag" --notes-file $NotesFile
            if ($LASTEXITCODE -ne 0) { throw 'Failed to create draft release.' }
        }
        & gh release upload $ReleaseTag --repo $env:AIDE_PUBLISH_REMOTE --clobber @Asset
        if ($LASTEXITCODE -ne 0) { throw 'Release upload failed; the release remains a draft.' }
        $uploadedJson = & gh release view $ReleaseTag --repo $env:AIDE_PUBLISH_REMOTE --json assets
        if ($LASTEXITCODE -ne 0) { throw 'Failed to verify uploaded assets.' }
        $uploaded = $uploadedJson | ConvertFrom-Json
        foreach ($file in $Asset) {
            $local = Get-Item -LiteralPath $file
            if (-not ($uploaded.assets | Where-Object { $_.name -eq $local.Name -and $_.size -eq $local.Length })) {
                throw "Uploaded asset mismatch: $($local.Name). Release remains a draft."
            }
        }
        & gh release edit $ReleaseTag --repo $env:AIDE_PUBLISH_REMOTE --draft=false --latest
        if ($LASTEXITCODE -ne 0) { throw 'Failed to publish draft release.' }
        & gh release view $ReleaseTag --repo $env:AIDE_PUBLISH_REMOTE --json url --jq .url
    }
} finally {
    $env:PATH = $previousPath
    $env:AIDE_PUBLISH_REMOTE = $previousRemote
    $env:HTTP_PROXY = $previousHttpProxy
    $env:HTTPS_PROXY = $previousHttpsProxy
    Pop-Location
}
