"""Create offline kasen release identities; private material stays outside Git."""
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys

os.umask(0o077)
root = Path.home() / '.config/SteamGuard/signing'
root.mkdir(parents=True, exist_ok=True)
root.chmod(0o700)
record_path = root / 'credentials.json'
if record_path.exists() and '--rotate-unpublished' not in sys.argv:
    raise SystemExit('Signing identity already exists. Reuse it for future releases.')
java = Path('/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/keytool')
keytool = str(java) if java.exists() else shutil.which('keytool')
if not keytool:
    raise SystemExit('Install a JDK first.')
if '--rotate-unpublished' in sys.argv:
    for name in ['kasen-android-release.jks', 'kasen-windows-signing.pfx', 'kasen-windows-signing.key', 'kasen-windows-signing.pem']:
        (root / name).unlink(missing_ok=True)
android = dict(alias='kasen', storePassword=secrets.token_urlsafe(36), keyPassword=secrets.token_urlsafe(36), keystore=str(root / 'kasen-android-release.jks'))
windows = dict(password=secrets.token_urlsafe(36), pfx=str(root / 'kasen-windows-signing.pfx'), privateKey=str(root / 'kasen-windows-signing.key'))
env = dict(os.environ, SG_STORE=android['storePassword'], SG_KEY=android['keyPassword'], SG_WINDOWS=windows['password'])
def run(args):
    subprocess.run(args, env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
public = Path(__file__).resolve().parent.parent / 'certificates'
public.mkdir(exist_ok=True)
run([keytool, '-genkeypair', '-keystore', android['keystore'], '-storetype', 'JKS', '-storepass:env', 'SG_STORE', '-keypass:env', 'SG_KEY', '-alias', android['alias'], '-keyalg', 'RSA', '-keysize', '3072', '-sigalg', 'SHA256withRSA', '-validity', '10000', '-dname', 'CN=kasen, OU=SteamGuard, O=kasen', '-noprompt'])
run([keytool, '-exportcert', '-rfc', '-keystore', android['keystore'], '-storepass:env', 'SG_STORE', '-alias', android['alias'], '-file', str(public / 'kasen-android-signing.pem')])
run(['openssl', 'req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-days', '3650', '-subj', '/CN=kasen/O=kasen/OU=SteamGuard', '-addext', 'basicConstraints=critical,CA:FALSE', '-addext', 'keyUsage=critical,digitalSignature', '-addext', 'extendedKeyUsage=codeSigning', '-addext', 'subjectKeyIdentifier=hash', '-passout', 'env:SG_WINDOWS', '-keyout', windows['privateKey'], '-out', str(root / 'kasen-windows-signing.pem')])
run(['openssl', 'pkcs12', '-export', '-name', 'kasen SteamGuard code signing', '-in', str(root / 'kasen-windows-signing.pem'), '-inkey', windows['privateKey'], '-passin', 'env:SG_WINDOWS', '-passout', 'env:SG_WINDOWS', '-out', windows['pfx']])
run(['openssl', 'x509', '-in', str(root / 'kasen-windows-signing.pem'), '-outform', 'DER', '-out', str(public / 'kasen-windows-signing.cer')])
def fingerprint(path, der=False):
    args = ['openssl', 'x509', '-in', str(path), '-outform', 'DER']
    if der:
        args += ['-inform', 'DER']
    value = subprocess.check_output(args)
    return dict(sha256=hashlib.sha256(value).hexdigest().upper(), sha1=hashlib.sha1(value).hexdigest().upper())
android['certificate'] = fingerprint(public / 'kasen-android-signing.pem')
windows['certificate'] = fingerprint(public / 'kasen-windows-signing.cer', True)
record = dict(owner='kasen', createdAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), android=android, windows=windows, notes='Private backup. Windows certificate is self-signed, not publicly trusted. Never upload this file as a release asset.')
record_path.write_text(json.dumps(record, indent=2) + '\n')
bundle = dict(android=dict(keystoreBase64=base64.b64encode(Path(android['keystore']).read_bytes()).decode(), alias=android['alias'], storePassword=android['storePassword'], keyPassword=android['keyPassword']), windows=dict(pfxBase64=base64.b64encode(Path(windows['pfx']).read_bytes()).decode(), password=windows['password'], thumbprint=windows['certificate']['sha1']))
(root / 'github-signing-secret.json').write_text(json.dumps(bundle, separators=(',', ':')))
for path in root.iterdir():
    path.chmod(0o600)
(public / 'fingerprints.json').write_text(json.dumps(dict(owner='kasen', android=android['certificate'], windows=windows['certificate'], windowsTrust='self-signed'), indent=2) + '\n')
print('Signing identities and owner-only private records created at', root)
