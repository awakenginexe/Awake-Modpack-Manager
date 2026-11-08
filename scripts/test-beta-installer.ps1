param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$SourceDir,
    [Parameter(Mandatory)][string]$TestDir
)
$ErrorActionPreference = 'Stop'
$setup = (Resolve-Path -LiteralPath $Installer).Path
$source = (Resolve-Path -LiteralPath $SourceDir).Path
$target = [IO.Path]::GetFullPath($TestDir)
if (Test-Path -LiteralPath $target) { throw 'Installer test requires a new directory on a disposable runner.' }
$data = Join-Path $env:LOCALAPPDATA 'AwakeModpackManager'
if (Test-Path -LiteralPath $data) { throw 'Installer test requires an empty user profile.' }
New-Item -ItemType Directory $data | Out-Null
$sentinel = Join-Path $data 'installer-preservation.txt'
'keep user projects' | Set-Content $sentinel
$pin = Get-Content (Join-Path $source 'scripts/helper-pin.json') -Raw | ConvertFrom-Json
$version = (Get-Content (Join-Path $source 'package.json') -Raw | ConvertFrom-Json).version
foreach ($pass in 1,2) {
    $process = Start-Process -FilePath $setup -ArgumentList "/S /D=$target" -PassThru -Wait -WindowStyle Hidden
    if ($process.ExitCode) { throw "Installer pass $pass failed: $($process.ExitCode)" }
    $exe = Join-Path $target 'awake-modpack-manager.exe'
    if ((Get-FileHash $exe).Hash -ne (Get-FileHash (Join-Path $source 'src-tauri/target/release/awake-modpack-manager.exe')).Hash) { throw 'Installed application differs from the build.' }
    if ((Get-Item $exe).VersionInfo.ProductVersion -ne $version) { throw 'Installed application has the wrong version.' }
    $helper = Join-Path $target 'core-host/windows-x64'
    if ((Get-FileHash (Join-Path $helper 'awake-core-host.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin.exeSha256) { throw 'Installed helper differs from pin.' }
    foreach ($line in Get-Content (Join-Path $helper 'SHA256SUMS')) {
        $parts = $line -split '\s+',2
        $file = [IO.Path]::GetFullPath((Join-Path $helper $parts[1]))
        if (!$file.StartsWith($helper + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe helper manifest path.' }
        if ((Get-FileHash $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $parts[0]) { throw "Installed helper file differs: $($parts[1])" }
    }
    foreach ($notice in 'LICENSE','THIRD-PARTY-NOTICES.txt','core-host/windows-x64/REDISTRIBUTION.md') {
        if (!(Test-Path -LiteralPath (Join-Path $target $notice))) { throw "Missing installed notice: $notice" }
    }
    if ((Get-Content $sentinel -Raw).Trim() -ne 'keep user projects') { throw 'Installer changed user data.' }
}
$uninstaller = @(Get-ChildItem -LiteralPath $target -Filter '*uninstall*.exe')
if ($uninstaller.Count -ne 1) { throw 'Expected one uninstaller.' }
$process = Start-Process $uninstaller[0].FullName -ArgumentList '/S' -PassThru -Wait -WindowStyle Hidden
if ($process.ExitCode) { throw 'Uninstall failed.' }
$deadline = [DateTime]::UtcNow.AddSeconds(15)
while ((Test-Path (Join-Path $target 'awake-modpack-manager.exe')) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
if (Test-Path (Join-Path $target 'awake-modpack-manager.exe')) { throw 'Uninstall left the application executable.' }
if ((Get-Content $sentinel -Raw).Trim() -ne 'keep user projects') { throw 'Uninstall changed user data.' }
'Manager NSIS install, upgrade, helper hashes, version, notices and user-data preservation passed.'
