import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Read-only final gate: a resumed draft must contain exactly this release's files. */
export function verifyReleaseAssets(release, directory) {
  if (!release || typeof release !== "object" || Array.isArray(release) || !Array.isArray(release.assets))
    throw new Error("Expected a GitHub REST release object with an assets array");
  const local = new Map();
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Local release directory contains a non-regular file: ${name}`);
    local.set(name, { file, size: stat.size });
  }
  if (!local.size) throw new Error("Local release directory must not be empty");

  const remote = new Map();
  for (const asset of release.assets) {
    if (!asset || typeof asset !== "object" || Array.isArray(asset) || typeof asset.name !== "string" || !asset.name)
      throw new Error("Release contains an asset without a valid name");
    if (remote.has(asset.name)) throw new Error(`Duplicate remote release asset: ${asset.name}`);
    remote.set(asset.name, asset);
  }
  const extra = [...remote.keys()].filter(name => !local.has(name));
  const missing = [...local.keys()].filter(name => !remote.has(name));
  if (extra.length || missing.length)
    throw new Error(`Release asset names differ${extra.length ? `; unexpected: ${extra.sort().join(", ")}` : ""}${missing.length ? `; missing: ${missing.sort().join(", ")}` : ""}`);

  let verifiedDigests = 0;
  for (const [name, expected] of local) {
    const asset = remote.get(name);
    if (!Number.isSafeInteger(asset.size) || asset.size < 0 || asset.size !== expected.size)
      throw new Error(`Release asset size mismatch: ${name}`);
    if (asset.state !== undefined && asset.state !== "uploaded")
      throw new Error(`Release asset upload is incomplete: ${name}`);
    // Older GitHub uploads may have no digest. A supplied digest must be
    // supported and match; never silently ignore malformed integrity metadata.
    if (asset.digest !== undefined && asset.digest !== null) {
      const digest = typeof asset.digest === "string" && /^sha256:([0-9a-f]{64})$/i.exec(asset.digest);
      if (!digest) throw new Error(`Invalid release asset SHA256 digest: ${name}`);
      const actual = createHash("sha256").update(readFileSync(expected.file)).digest("hex");
      if (actual !== digest[1].toLowerCase())
        throw new Error(`Release asset SHA256 mismatch: ${name}`);
      verifiedDigests++;
    }
  }
  return { assets: local.size, verifiedDigests };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2) throw new Error("Usage: node scripts/verify-release-assets.mjs <release-rest.json> <local-release-directory>");
  const release = JSON.parse(readFileSync(args[0], "utf8"));
  const result = verifyReleaseAssets(release, args[1]);
  console.log(`Verified ${result.assets} release assets; ${result.verifiedDigests} remote SHA256 digests checked.`);
}
