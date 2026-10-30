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
  for (const name of [
    "kasen-android-signing.pem",
    "kasen-windows-signing.cer",
    "fingerprints.json",
  ])
    writeFileSync(path.join(root, "certificates", name), "public fixture");
  for (const name of [
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
  return root;
}
function collect(root, tag = "v1.0.0") {
  return spawnSync(process.execPath, [script, "input", "output"], {
    cwd: root,
    env: { ...process.env, GITHUB_REF_NAME: tag },
    encoding: "utf8",
  });
}
test("collects only installers and public verification files; checksums match", () => {
  const root = fixture();
  try {
    assert.equal(collect(root).status, 0);
    const names = readdirSync(path.join(root, "output"));
    assert.equal(names.length, 12);
    assert(!names.some((n) => /pfx|credentials|debug|simulator/.test(n)));
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
