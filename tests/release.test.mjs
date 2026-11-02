import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { verifyUpdaterSignature } from "../scripts/updater-signature.mjs";

const script = path.resolve("scripts/collect-release.mjs");
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "steamguard-release-"));
  mkdirSync(path.join(root, "input"));
  mkdirSync(path.join(root, "certificates"));
  mkdirSync(path.join(root, "src-tauri"));
  const {publicKey, privateKey} = generateKeyPairSync('ed25519');
  const keyId = randomBytes(8), rawKey = publicKey.export({format:'der',type:'spki'}).subarray(-32);
  const pub = Buffer.from('untrusted comment: synthetic test key\n'+Buffer.concat([Buffer.from('Ed'),keyId,rawKey]).toString('base64')+'\n').toString('base64');
  writeFileSync(path.join(root,'src-tauri','tauri.conf.json'), JSON.stringify({plugins:{updater:{pubkey:pub}}}));
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ version: "1.0.0" }),
  );
  writeFileSync(path.join(root, "LICENSE"), "fixture license");
  writeFileSync(path.join(root, "CHANGELOG.md"), "# Updates\n\n## 1.0.0\n\n- Synthetic feature\n");
  for (const name of [
    "kasen-android-signing.pem",
    "kasen-windows-signing.cer",
    "fingerprints.json",
  ])
    writeFileSync(path.join(root, "certificates", name), "public fixture");
  for (const name of [
    "SteamGuard_1.0.0_aarch64.app.tar.gz",
    "SteamGuard_1.0.0_x64.app.tar.gz",
    "SteamGuard_1.0.0_aarch64.dmg",
    "SteamGuard_1.0.0_x64.dmg",
    "SteamGuard_1.0.0_x64-setup.exe",
    "SteamGuard_1.0.0_x64_en-US.msi",
    "app-universal-release.apk",
    "app-universal-release.aab",
    "SteamGuard-iOS-arm64-unsigned.ipa",
    "debug.apk",
    "signing.pfx",
    "credentials.json",
    "simulator.zip",
  ])
    writeFileSync(path.join(root, "input", name), `synthetic ${name}`);
  for (const name of ['SteamGuard_1.0.0_aarch64.app.tar.gz','SteamGuard_1.0.0_x64.app.tar.gz','SteamGuard_1.0.0_x64-setup.exe','SteamGuard_1.0.0_x64_en-US.msi']) {
    const signature=sign(null,createHash('blake2b512').update(readFileSync(path.join(root,'input',name))).digest(),privateKey);
    const comment='timestamp:0\tfile:'+name+'\tversion:1.0.0';
    const global=sign(null,Buffer.concat([signature,Buffer.from(comment)]),privateKey);
    writeFileSync(path.join(root,'input',name+'.sig'),Buffer.from('untrusted comment: synthetic fixture\n'+Buffer.concat([Buffer.from('ED'),keyId,signature]).toString('base64')+'\ntrusted comment: '+comment+'\n'+global.toString('base64')+'\n').toString('base64'));
  }
  return root;
}
function collect(root, tag = "v1.0.0") {
  return spawnSync(process.execPath, [script, "input", "output"], {
    cwd: root,
    env: { ...process.env, GITHUB_REF_NAME: tag },
    encoding: "utf8",
  });
}
test("collects installers and signed updater metadata without identities", () => {
  const root = fixture();
  try {
    assert.equal(collect(root).status, 0);
    const names = readdirSync(path.join(root, "output"));
    assert.equal(names.length, 12);
    assert(!names.some(name => name.endsWith('.sig')));
    const manifest = JSON.parse(readFileSync(path.join(root,'output','latest.json'),'utf8'));
    assert.equal(manifest.version,'1.0.0');
    assert.deepEqual(Object.keys(manifest.platforms).sort(),['darwin-aarch64','darwin-x86_64','windows-x86_64','windows-x86_64-msi','windows-x86_64-nsis']);
    assert(manifest.platforms['windows-x86_64-msi'].url.endsWith('.msi'));
    assert(manifest.platforms['windows-x86_64-nsis'].url.endsWith('-setup.exe'));
    for (const platform of Object.values(manifest.platforms)) {
      assert.match(platform.url,/^https:\/\/github\.com\/lx8s8\/SteamGuard\/releases\/download\/v1\.0\.0\//);
      assert.match(Buffer.from(platform.signature,'base64').toString(),/trusted comment:/);
      assert(names.includes(platform.url.split('/').at(-1)));
    }
    assert(
      !names.some((n) =>
        /pem|cer|fingerprints|pfx|credentials|debug|simulator/.test(n),
      ),
    );
    for (const line of readFileSync(
      path.join(root, "output", "SHA256SUMS"),
      "utf8",
    )
      .trim()
      .split("\n")) {
      const [hash, name] = line.split("  ");
      assert.equal(
        hash,
        createHash("sha256")
          .update(readFileSync(path.join(root, "output", name)))
          .digest("hex"),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("missing or duplicate platform installer prevents publication", () => {
  const root = fixture();
  try {
    rmSync(path.join(root, "input", "app-universal-release.apk"));
    assert.notEqual(collect(root).status, 0);
    writeFileSync(
      path.join(root, "input", "app-universal-release.apk"),
      "synthetic",
    );
    mkdirSync(path.join(root, "input", "duplicate"));
    copyFileSync(
      path.join(root, "input", "app-universal-release.apk"),
      path.join(root, "input", "duplicate", "app-universal-release.apk"),
    );
    assert.notEqual(collect(root).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("mismatched version tag prevents publication", () => {
  const root = fixture();
  try {
    assert.notEqual(collect(root, "v0.1.1").status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repeated collection excludes the checksum file from its own manifest", () => {
  const root = fixture();
  try {
    assert.equal(collect(root).status, 0);
    const before = readFileSync(
      path.join(root, "output", "SHA256SUMS"),
      "utf8",
    );
    assert.equal(collect(root).status, 0);
    assert.equal(
      readFileSync(path.join(root, "output", "SHA256SUMS"), "utf8"),
      before,
    );
    assert.equal(before.trim().split("\n").length, 11);
    assert(!before.includes("  SHA256SUMS"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("stale certificate files in the output directory block publication", () => {
  const root = fixture();
  try {
    assert.equal(collect(root).status, 0);
    writeFileSync(
      path.join(root, "output", "unexpected-certificate.pem"),
      "public fixture",
    );
    assert.notEqual(collect(root).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing or malformed updater signature prevents publication", () => {
  const root = fixture();
  try {
    const signature = path.join(root,'input','SteamGuard_1.0.0_x64-setup.exe.sig');
    rmSync(signature);
    assert.notEqual(collect(root).status,0);
    writeFileSync(signature,Buffer.from('not a signature').toString('base64'));
    assert.notEqual(collect(root).status,0);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("actual Tauri CLI signature verifies the payload and binds the version", () => {
  const payload = readFileSync('tests/fixtures/updater/payload.txt');
  const signature = readFileSync('tests/fixtures/updater/payload.sig','utf8').trim();
  const publicKey = readFileSync('tests/fixtures/updater/public-key.txt','utf8').trim();
  verifyUpdaterSignature(payload, signature, publicKey, '2.0.0');
  assert.throws(() => verifyUpdaterSignature(Buffer.concat([payload,Buffer.from('tampered')]),signature,publicKey,'2.0.0'));
  assert.throws(() => verifyUpdaterSignature(payload,signature,publicKey,'9.9.9'));
  const tampered = Buffer.from(signature,'base64').toString().replace('version:2.0.0','version:9.9.9');
  assert.throws(() => verifyUpdaterSignature(payload,Buffer.from(tampered).toString('base64'),publicKey,'9.9.9'));
});

test("tampered artifact or wrong signing identity blocks the entire publication", () => {
  const root=fixture();
  try {
    writeFileSync(path.join(root,'input','SteamGuard_1.0.0_x64-setup.exe'),'tampered');
    assert.notEqual(collect(root).status,0);
  } finally { rmSync(root,{recursive:true,force:true}); }
  const other=fixture();
  try {
    const conf=JSON.parse(readFileSync(path.join(other,'src-tauri','tauri.conf.json'),'utf8'));
    conf.plugins.updater.pubkey=readFileSync('tests/fixtures/updater/public-key.txt','utf8').trim();
    writeFileSync(path.join(other,'src-tauri','tauri.conf.json'),JSON.stringify(conf));
    assert.notEqual(collect(other).status,0);
  } finally { rmSync(other,{recursive:true,force:true}); }
});
