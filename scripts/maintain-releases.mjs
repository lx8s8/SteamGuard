// A repository-owned, explicit maintenance plan. Installer binaries are never replaced.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { releaseNotes } from "./release-notes.mjs";

export function assetNames(tag) {
  assert.match(tag, /^v\d+\.\d+\.\d+$/);
  const version = tag.slice(1);
  return [
    `SteamGuard_${version}_aarch64.dmg`,
    `SteamGuard_${version}_x64.dmg`,
    `SteamGuard_${version}_x64-setup.exe`,
    `SteamGuard_${version}_x64_en-US.msi`,
    `SteamGuard_${version}_android-universal.apk`,
    `SteamGuard_${version}_android-universal.aab`,
    `SteamGuard_${version}_ios-arm64-LiveContainer.ipa`,
    "LICENSE.txt",
  ];
}
export function checksums(assets, tag) {
  return (
    assetNames(tag)
      .sort()
      .map((name) => {
        const found = assets.filter((asset) => asset.name === name);
        assert.equal(found.length, 1, `Expected one ${name}`);
        assert.match(found[0].digest ?? "", /^sha256:[0-9a-f]{64}$/);
        return `${found[0].digest.slice(7)}  ${name}`;
      })
      .join("\n") + "\n"
  );
}
export function planMaintenance(
  plan,
  releases,
  changelog,
  identifiers,
  currentIdentifier,
  version,
) {
  assert.equal(plan.repository, "lx8s8/SteamGuard");
  assert.equal(plan.operation, "release-cleanup-2026-11-01");
  const tags = [...plan.retain, ...plan.withdraw];
  assert.equal(new Set(tags).size, tags.length, "Duplicate release targets");
  assert(
    plan.retain.includes(`v${version}`),
    "Current version must be retained",
  );
  assert.equal(plan.removeAssets.length, 3);
  assert.deepEqual(
    new Set(plan.removeAssets),
    new Set([
      "kasen-android-signing.pem",
      "kasen-windows-signing.cer",
      "fingerprints.json",
    ]),
  );
  for (const tag of tags) assert.match(tag, /^v\d+\.\d+\.\d+$/);
  for (const release of releases) {
    if (!release.draft)
      assert(
        tags.includes(release.tag_name),
        `Unreviewed public release ${release.tag_name}`,
      );
  }
  const retain = plan.retain.map((tag) => {
    assert.equal(
      identifiers[tag],
      currentIdentifier,
      `Cannot retain legacy application ${tag}`,
    );
    const release = releases.find((item) => item.tag_name === tag);
    assert(
      release && !release.draft && !release.immutable,
      `Release ${tag} must be public and editable`,
    );
    const allowed = new Set([
      ...assetNames(tag),
      "SHA256SUMS",
      ...plan.removeAssets,
    ]);
    assert(
      release.assets.every((asset) => allowed.has(asset.name)),
      `Unexpected attachment in ${tag}`,
    );
    return {
      release,
      protected: release.assets.filter((asset) =>
        assetNames(tag).includes(asset.name),
      ),
      remove: release.assets.filter((asset) =>
        plan.removeAssets.includes(asset.name),
      ),
      checksum: checksums(release.assets, tag),
      body: releaseNotes(changelog, tag.slice(1)),
    };
  });
  const withdraw = plan.withdraw.map((tag) => {
    assert(
      identifiers[tag] && identifiers[tag] !== currentIdentifier,
      `Refusing to withdraw current application ${tag}`,
    );
    return { tag, release: releases.find((item) => item.tag_name === tag) };
  });
  return { retain, withdraw };
}

async function run() {
  const apply = process.argv.includes("--apply");
  const snapshot = process.argv
    .find((arg) => arg.startsWith("--snapshot="))
    ?.slice(11);
  assert(
    !(apply && snapshot),
    "Live metadata is required when applying changes",
  );
  const plan = JSON.parse(
    readFileSync(".github/release-maintenance.json", "utf8"),
  );
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  const currentIdentifier = JSON.parse(
    readFileSync("src-tauri/tauri.conf.json", "utf8"),
  ).identifier;
  const changelog = readFileSync("CHANGELOG.md", "utf8");
  const token = process.env.GH_TOKEN;
  if (apply) {
    assert(token, "Authenticated repository token required");
    assert.equal(process.env.GITHUB_REPOSITORY, plan.repository);
    assert.equal(process.env.GITHUB_REF_NAME, "main");
  }
  const base = `/repos/${plan.repository}`;
  async function request(route, { method = "GET", data, bytes } = {}) {
    const url = new URL(
      route.startsWith("https://") ? route : `https://api.github.com${route}`,
    );
    assert(["api.github.com", "uploads.github.com"].includes(url.hostname));
    assert.equal(url.protocol, "https:");
    assert(url.pathname.startsWith(`${base}/`));
    const attempts = method === "GET" ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await fetch(url, {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2026-03-10",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(bytes
              ? { "Content-Type": "application/octet-stream" }
              : data
                ? { "Content-Type": "application/json" }
                : {}),
          },
          body: bytes || (data ? JSON.stringify(data) : undefined),
        });
        if (
          response.status === 404 &&
          (method === "GET" || method === "DELETE")
        )
          return null;
        if (!response.ok)
          throw new Error(`GitHub ${method} returned ${response.status}`);
        return response.status === 204 ? null : await response.json();
      } catch (error) {
        if (attempt + 1 === attempts) throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * (attempt + 1)),
        );
      }
    }
  }
  let releases = snapshot ? JSON.parse(readFileSync(snapshot, "utf8")) : [];
  if (!snapshot) {
    for (let page = 1; ; page++) {
      const batch = await request(`${base}/releases?per_page=100&page=${page}`);
      assert(Array.isArray(batch));
      releases.push(...batch);
      if (batch.length < 100) break;
    }
  }
  const identifiers = {};
  for (const tag of [...plan.retain, ...plan.withdraw]) {
    assert.match(tag, /^v\d+\.\d+\.\d+$/);
    identifiers[tag] = JSON.parse(
      execFileSync("git", ["show", `${tag}:src-tauri/tauri.conf.json`], {
        encoding: "utf8",
      }),
    ).identifier;
  }
  const prepared = planMaintenance(
    plan,
    releases,
    changelog,
    identifiers,
    currentIdentifier,
    version,
  );
  console.log(
    JSON.stringify(
      {
        apply,
        retain: prepared.retain.map((item) => ({
          tag: item.release.tag_name,
          removeAttachments: item.remove.length,
          finalAttachments: 9,
        })),
        withdraw: prepared.withdraw.map((item) => item.tag),
      },
      null,
      2,
    ),
  );
  if (!apply) return;
  // Finish validation of every target before the first remote write.
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    "artifacts/release-maintenance-before.json",
    JSON.stringify(releases, null, 2),
  );
  const report = [];
  for (const item of prepared.retain) {
    const { release } = item;
    for (const asset of item.remove)
      await request(`${base}/releases/assets/${asset.id}`, {
        method: "DELETE",
      });
    const oldSum = release.assets.find((asset) => asset.name === "SHA256SUMS");
    if (oldSum)
      await request(`${base}/releases/assets/${oldSum.id}`, {
        method: "DELETE",
      });
    const uploadUrl = release.upload_url.replace(/\{.*$/, "");
    const uploaded = await request(`${uploadUrl}?name=SHA256SUMS`, {
      method: "POST",
      bytes: Buffer.from(item.checksum),
    });
    assert.equal(
      uploaded.digest,
      `sha256:${createHash("sha256").update(item.checksum).digest("hex")}`,
    );
    await request(`${base}/releases/${release.id}`, {
      method: "PATCH",
      data: {
        name: `SteamGuard ${release.tag_name}`,
        body: item.body,
        ...(release.tag_name === `v${version}` ? { make_latest: "true" } : {}),
      },
    });
    const after = await request(`${base}/releases/${release.id}`);
    assert.equal(after.assets.length, 9);
    assert.equal(after.body, item.body);
    assert(
      after.assets.every((asset) =>
        [...assetNames(release.tag_name), "SHA256SUMS"].includes(asset.name),
      ),
    );
    for (const original of item.protected) {
      const current = after.assets.find((asset) => asset.id === original.id);
      assert(
        current &&
          current.name === original.name &&
          current.digest === original.digest &&
          current.size === original.size,
        "Installer or license changed unexpectedly",
      );
    }
    report.push({
      tag: release.tag_name,
      status: "retained",
      attachments: after.assets.length,
      installersUnchanged: true,
    });
  }
  for (const item of prepared.withdraw) {
    if (item.release)
      await request(`${base}/releases/${item.release.id}`, {
        method: "DELETE",
      });
    assert.equal(
      await request(`${base}/releases/tags/${item.tag}`),
      null,
      `Release ${item.tag} is still published`,
    );
    report.push({
      tag: item.tag,
      status: "withdrawn",
      sourceTagRetained: true,
    });
  }
  writeFileSync(
    "artifacts/release-maintenance-report.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
