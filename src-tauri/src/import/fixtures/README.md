# Synthetic compatibility fixtures

These files contain the public test secret `1234567890`, never real accounts.
The fixture password is `fixture-password-秘密`.

`LegacyFixture.java` independently produces the WinAuth and WattToolkit v1
fixtures using BouncyCastle's original Blowfish engine, PBKDF2-SHA1 and ISO10126
padding rather than the Rust reader. It derives **256 bytes**, matching
BeyondDimension/WinAuth `Authenticator.cs` at commit
`95bf35943d7f610567e72fe662e00aa627b25bc3`.

Reproduce with a JDK and BouncyCastle `bcprov-jdk15on:1.50` from Maven Central:

```sh
curl -fL https://repo.maven.apache.org/maven2/org/bouncycastle/bcprov-jdk15on/1.50/bcprov-jdk15on-1.50.jar -o /tmp/bcprov-1.50.jar
# SHA256: 115b14a02b91fb03cb1866d6b311d33cd5518a9d8524dd63a14f19571e420404
javac -cp /tmp/bcprov-1.50.jar src-tauri/src/import/fixtures/LegacyFixture.java
java -cp /tmp/bcprov-1.50.jar:src-tauri/src/import/fixtures LegacyFixture src-tauri/src/import/fixtures
```

The old engine accepts WinAuth's nonstandard long key; newer providers may
correctly reject keys above the normal Blowfish maximum. It is used only in this
offline fixture generator, never as an application dependency.

- `winauth-password.xml`: whole configuration, WINAUTH3 SHA256 envelope.
- `winauth-record-password.xml`: one protected authenticator, XML declaration.
- `winauth-v2-password.xml`: protected secret bytes with a WINAUTH3 checksum.
- `winauth-v2-unverified.xml`: old protected secret bytes without WINAUTH3;
  explicitly rejected because valid random padding cannot verify a password.
- `watt-v1.dat.txt`: Base64(GZip(UTF8 `<Auth>` XML)); `.txt` keeps the fixture
  readable and makes its synthetic nature clear.

The generator's password, salts, padding seed and output are deliberately public
test data and must not be used for real backups.

## MemoryPack

`MemoryPackFixture.cs` / `.csproj` use official NuGet `MemoryPack` 1.21.4's source
generator, with exact schemas copied from the upstream model definitions (not a
handwritten byte encoder):

- `AuthenticatorExportDTO`: BeyondDimension/WinAuth, same commit above, 11 explicit fields.
- `AccountPlatformAuthenticator`: WattToolkit `Entities/AccountPlatformAuthenticator.cs`,
  eight MemoryPack fields (the server GUID is included, the database ID is ignored).

The files cover single / list records, UTF8 / UTF16, Steam metadata and HOTP,
and the existing public resource AES wrapper around MessagePack account values.
The resource is a public format compatibility key, never an account secret.
They contain only the synthetic secrets `1234567890` / `12345678901234567890`.

Reproduce with .NET 9 without creating build artifacts in the repository:

```sh
mkdir -p /tmp/steamguard-memorypack-fixture
cp src-tauri/src/import/fixtures/MemoryPackFixture.cs /tmp/steamguard-memorypack-fixture/Program.cs
cp src-tauri/src/import/fixtures/MemoryPackFixture.csproj /tmp/steamguard-memorypack-fixture/Fixture.csproj
dotnet run --project /tmp/steamguard-memorypack-fixture/Fixture.csproj -- "$PWD/src-tauri/src/import/fixtures"
```
