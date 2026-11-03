import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { verifyReleaseAssets } from "../scripts/verify-release-assets.mjs";

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "steamguard-release-assets-"));
  for (const [name, bytes] of [["SteamGuard_1.6.0_x64-setup.exe", "synthetic installer"], ["latest.json", '{"version":"1.6.0"}'], ["SHA256SUMS", "synthetic manifest"]])
    writeFileSync(path.join(directory, name), bytes);
  const release = { draft: true, assets: readdirSync(directory).map(name => {
    const bytes = readFileSync(path.join(directory, name));
    return {name, size: bytes.length, state: "uploaded", digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`};
  }) };
  return {directory, release};
}
function usingFixture(job) {
  const value = fixture();
  try { job(value); } finally { rmSync(value.directory, {recursive:true, force:true}); }
}

test("resumed draft exactly matches local assets and remote SHA256 digests", () => usingFixture(({directory, release}) => {
  const before = JSON.stringify(release);
  assert.deepEqual(verifyReleaseAssets(release, directory), {assets:3, verifiedDigests:3});
  assert.equal(JSON.stringify(release), before, "verification must not mutate the remote metadata");
  release.assets[0].digest = release.assets[0].digest.toUpperCase();
  assert.equal(verifyReleaseAssets(release, directory).verifiedDigests, 3);
}));

test("legacy uploads without remote digests still require exact names and sizes", () => usingFixture(({directory, release}) => {
  release.assets[0].digest = null;
  delete release.assets[1].digest;
  assert.deepEqual(verifyReleaseAssets(release, directory), {assets:3, verifiedDigests:1});
  release.assets[0].size++;
  assert.throws(() => verifyReleaseAssets(release, directory), /size mismatch/);
}));

test("old certificates and missing or duplicate remote assets prevent publication", () => usingFixture(({directory, release}) => {
  for (const name of ["kasen-android-signing.pem", "kasen-windows-signing.cer", "fingerprints.json"]) {
    assert.throws(() => verifyReleaseAssets({...release, assets:[...release.assets, {name, size:10}]}, directory), /unexpected:/);
  }
  assert.throws(() => verifyReleaseAssets({...release, assets:release.assets.slice(1)}, directory), /missing:/);
  assert.throws(() => verifyReleaseAssets({...release, assets:[...release.assets, release.assets[0]]}, directory), /Duplicate remote/);
}));

test("same-sized tampering, invalid digests and unfinished uploads are rejected", () => usingFixture(({directory, release}) => {
  const asset = release.assets[0];
  const original = asset.digest;
  asset.digest = `sha256:${"0".repeat(64)}`;
  assert.throws(() => verifyReleaseAssets(release, directory), /SHA256 mismatch/);
  for (const invalid of ["", "sha256:abcd", "sha512:"+"a".repeat(128), 42, {}]) {
    asset.digest = invalid;
    assert.throws(() => verifyReleaseAssets(release, directory), /Invalid release asset SHA256/);
  }
  asset.digest = original;
  asset.state = "starter";
  assert.throws(() => verifyReleaseAssets(release, directory), /upload is incomplete/);
}));

test("malformed remote sizes and metadata are rejected", () => usingFixture(({directory, release}) => {
  for (const invalid of [-1, NaN, Infinity, "18", Number.MAX_SAFE_INTEGER+1, null]) {
    release.assets[0].size = invalid;
    assert.throws(() => verifyReleaseAssets(release, directory), /size mismatch/);
  }
  for (const invalid of [null, [], {}, {assets:null}, {assets:[null]}, {assets:[{name:""}]}])
    assert.throws(() => verifyReleaseAssets(invalid, directory));
}));

test("local non-files and empty directories cannot supply the release whitelist", () => usingFixture(({directory, release}) => {
  const nested = path.join(directory, "nested");
  mkdirSync(nested);
  assert.throws(() => verifyReleaseAssets(release, directory), /non-regular file/);
  rmSync(nested, {recursive:true});
  for (const name of readdirSync(directory)) rmSync(path.join(directory,name));
  assert.throws(() => verifyReleaseAssets({assets:[]}, directory), /must not be empty/);
}));

test("local symlinks cannot bypass the release whitelist", context => usingFixture(({directory, release}) => {
  const linked = path.join(directory, "linked.pem");
  try { symlinkSync(path.join(directory, "latest.json"), linked); }
  catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") { context.skip("Windows account cannot create symlinks"); return; }
    throw error;
  }
  assert.throws(() => verifyReleaseAssets(release, directory), /non-regular file/);
}));

test("CLI exits nonzero for a stale draft and reads metadata without publishing", () => usingFixture(({directory, release}) => {
  const metadata = path.join(tmpdir(), `steamguard-release-rest-${path.basename(directory)}.json`);
  const script = path.resolve("scripts/verify-release-assets.mjs");
  try {
    writeFileSync(metadata,JSON.stringify(release));
    const run = () => spawnSync(process.execPath,[script,metadata,directory],{encoding:"utf8"});
    const good = run();
    assert.equal(good.status,0,good.stderr);
    assert.match(good.stdout,/Verified 3 release assets; 3 remote SHA256 digests checked/);
    release.assets.push({name:"fingerprints.json",size:370});
    writeFileSync(metadata,JSON.stringify(release));
    assert.notEqual(run().status,0);
    assert.equal(JSON.parse(readFileSync(metadata,"utf8")).assets.length,4);
    assert.equal(readdirSync(directory).length,3);
  } finally { rmSync(metadata,{force:true}); }
}));
