import test from "node:test";
import assert from "node:assert/strict";
import {
  assetNames,
  checksums,
  planMaintenance,
} from "../scripts/maintain-releases.mjs";
const plan = {
  repository: "lx8s8/SteamGuard",
  operation: "release-cleanup-2026-11-01",
  retain: ["v1.2.0", "v1.3.0"],
  withdraw: ["v1.0.0", "v1.0.1", "v1.1.0"],
  removeAssets: [
    "kasen-android-signing.pem",
    "kasen-windows-signing.cer",
    "fingerprints.json",
  ],
};
function fixtures() {
  let id = 1;
  const identifiers = {};
  const releases = [...plan.retain, ...plan.withdraw].map((tag) => {
    identifiers[tag] = plan.retain.includes(tag)
      ? "current.application"
      : "legacy.application";
    return {
      id: id++,
      tag_name: tag,
      draft: false,
      immutable: false,
      assets: [...assetNames(tag), "SHA256SUMS", ...plan.removeAssets].map(
        (name) => ({
          id: id++,
          name,
          size: 100,
          digest: `sha256:${"a".repeat(64)}`,
        }),
      ),
    };
  });
  return { releases, identifiers };
}
const changelog =
  "# Updates\n\n## 1.3.0\n\n- Sync tokens\n\n## 1.2.0\n\n- Token groups\n";
const prepare = (data) =>
  planMaintenance(
    plan,
    data.releases,
    changelog,
    data.identifiers,
    "current.application",
    "1.3.0",
  );
test("maintenance retains every installer and removes only reviewed extra attachments", () => {
  const result = prepare(fixtures());
  assert.equal(result.retain.length, 2);
  assert.equal(result.withdraw.length, 3);
  for (const item of result.retain) {
    assert.equal(item.protected.length, 8);
    assert.equal(item.remove.length, 3);
    assert.equal(item.checksum.trim().split("\n").length, 8);
    assert.doesNotMatch(item.checksum, /fingerprints|pem|cer|  SHA256SUMS/);
    assert.doesNotMatch(item.body, /kasen|fingerprints/iu);
  }
});
test("missing binaries or checksum digests abort preflight", () => {
  const data = fixtures();
  data.releases[0].assets.shift();
  assert.throws(() => prepare(data));
  const other = fixtures();
  other.releases[0].assets[0].digest = null;
  assert.throws(() => prepare(other));
  assert.throws(() => checksums([], "v1.3.0"));
});
test("current application versions cannot be withdrawn and unknown releases require review", () => {
  const data = fixtures();
  data.identifiers["v1.1.0"] = "current.application";
  assert.throws(() => prepare(data));
  const other = fixtures();
  other.releases.push({ tag_name: "v1.4.0", draft: false, assets: [] });
  assert.throws(() => prepare(other));
});
test("maintenance is retryable after obsolete releases and extra attachments are gone", () => {
  const data = fixtures();
  data.releases = data.releases.filter((r) => plan.retain.includes(r.tag_name));
  for (const r of data.releases)
    r.assets = r.assets.filter((a) => !plan.removeAssets.includes(a.name));
  const result = prepare(data);
  assert(result.retain.every((r) => r.remove.length === 0));
  assert(result.withdraw.every((r) => !r.release));
});
