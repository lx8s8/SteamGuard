$ErrorActionPreference = 'Stop'
$settings = $env:STEAMGUARD_SIGNING | ConvertFrom-Json
$password = ConvertTo-SecureString -String $settings.windows.password -AsPlainText -Force
$certificate = Import-PfxCertificate -FilePath (Join-Path $env:STEAMGUARD_SIGNING_DIR 'release.pfx') -CertStoreLocation Cert:\CurrentUser\My -Password $password
if ($certificate.Thumbprint -ne $settings.windows.thumbprint -or -not $certificate.HasPrivateKey) {
    throw 'Unexpected Windows signing identity'
}
# Do not install a self-signed certificate into the trusted root store.
Write-Output 'kasen signing certificate imported into the temporary runner personal store'
