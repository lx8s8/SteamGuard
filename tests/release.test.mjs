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
import { createHash } from "node:crypto";

const script = path.resolve("scripts/collect-release.mjs");
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "steamguard-release-"));
  mkdirSync(path.join(root, "input"));
  mkdirSync(path.join(root, "certificates"));
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
  const signature = Buffer.from('untrusted comment: synthetic fixture\nTEST\ntrusted comment: timestamp:0\nTEST\n').toString('base64');
  for (const name of ['SteamGuard_1.0.0_aarch64.app.tar.gz','SteamGuard_1.0.0_x64.app.tar.gz','SteamGuard_1.0.0_x64-setup.exe','SteamGuard_1.0.0_x64_en-US.msi']) writeFileSync(path.join(root,'input',name+'.sig'),signature);
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
