$ErrorActionPreference = 'Stop'
$expected = (Get-Content certificates/fingerprints.json | ConvertFrom-Json).windows.sha1
$base = Join-Path (Get-Location) 'src-tauri/target/x86_64-pc-windows-msvc/release/bundle'
function Assert-KasenSignature([string] $file) {
    $signature = Get-AuthenticodeSignature -FilePath $file
    # WinVerifyTrust reports an untrusted self-signed root differently across Windows versions.
    $untrustedRoot = $signature.Status -eq 'UnknownError' -and $signature.StatusMessage -match 'terminated in a root certificate which is not trusted'
    if ($signature.SignerCertificate.Thumbprint -ne $expected -or ($signature.Status -notin 'Valid', 'NotTrusted' -and -not $untrustedRoot)) {
        throw "Signature verification failed: $file ($($signature.Status)): $($signature.StatusMessage)"
    }
    Write-Output "Verified kasen signature: $([IO.Path]::GetFileName($file))"
}
$installers = @(Get-ChildItem $base -Recurse -File | Where-Object { $_.Extension -in '.exe', '.msi' })
if ($installers.Count -ne 2) { throw 'Expected one NSIS installer and one MSI installer' }
foreach ($file in $installers) { Assert-KasenSignature $file.FullName }

# tauri-bundler restores target/release/steamguard.exe to its unsigned, unpatched
# original after packaging. Verify the app actually inside each installer instead.
$msi = ($installers | Where-Object Extension -eq '.msi').FullName
$msiDir = Join-Path $env:RUNNER_TEMP 'steamguard-msi-verification'
$msiLog = Join-Path $env:RUNNER_TEMP 'steamguard-msi-verification.log'
$extract = Start-Process msiexec.exe -ArgumentList @('/a', "`"$msi`"", '/qn', "TARGETDIR=`"$msiDir`"", '/L*v', "`"$msiLog`"") -Wait -PassThru
if ($extract.ExitCode -ne 0) { throw "MSI extraction failed: $($extract.ExitCode)" }
$apps = @(Get-ChildItem $msiDir -Recurse -File -Filter 'steamguard.exe')
if ($apps.Count -ne 1) { throw 'Expected one application inside MSI' }
Assert-KasenSignature $apps[0].FullName

$nsis = ($installers | Where-Object Extension -eq '.exe').FullName
$nsisDir = Join-Path $env:RUNNER_TEMP 'steamguard-nsis-verification'
$install = Start-Process $nsis -ArgumentList @('/S', "/D=$nsisDir") -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "NSIS installation failed: $($install.ExitCode)" }
Assert-KasenSignature (Join-Path $nsisDir 'steamguard.exe')
$uninstaller = Join-Path $nsisDir 'uninstall.exe'
Assert-KasenSignature $uninstaller
$remove = Start-Process $uninstaller -ArgumentList '/S' -Wait -PassThru
if ($remove.ExitCode -ne 0) { throw "NSIS uninstall failed: $($remove.ExitCode)" }
Write-Output 'Verified installers, both packaged application binaries and NSIS uninstaller; silent install/uninstall completed'
