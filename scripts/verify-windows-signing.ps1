$ErrorActionPreference = 'Stop'
$expected = (Get-Content certificates/fingerprints.json | ConvertFrom-Json).windows.sha1
$base = 'src-tauri/target/x86_64-pc-windows-msvc/release'
$files = @((Join-Path $base 'steamguard.exe')) + @(Get-ChildItem "$base/bundle" -Recurse -File | Where-Object { $_.Extension -in '.exe', '.msi' } | ForEach-Object FullName)
if ($files.Count -ne 3) { throw 'Expected app executable, NSIS installer and MSI installer' }
foreach ($file in $files) {
    $signature = Get-AuthenticodeSignature -FilePath $file
    if ($signature.SignerCertificate.Thumbprint -ne $expected -or $signature.Status -notin 'Valid', 'NotTrusted') {
        throw "Signature verification failed: $file ($($signature.Status))"
    }
}
Write-Output 'Verified kasen Authenticode signatures on app, EXE and MSI (self-signed identity)'
