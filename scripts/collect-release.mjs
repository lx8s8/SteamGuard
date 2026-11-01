import {
  mkdirSync,
  readdirSync,
  readFileSync,
  copyFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
if (process.env.GITHUB_REF_NAME !== `v${version}`)
  throw new Error("Release tag and application version must match");
const source = process.argv[2] || "downloaded-artifacts";
const output = process.argv[3] || "release";
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(p) : [p];
  });
}
const files = walk(source);
mkdirSync(output, { recursive: true });
const specs = [
  ["macOS ARM64", (p) => p.endsWith("_aarch64.dmg"), null],
  ["macOS Intel", (p) => p.endsWith("_x64.dmg"), null],
  ["Windows EXE", (p) => p.endsWith("-setup.exe"), null],
  ["Windows MSI", (p) => p.endsWith(".msi"), null],
  [
    "Android APK",
    (p) => p.endsWith("app-universal-release.apk"),
    `SteamGuard_${version}_android-universal.apk`,
  ],
  [
    "Android AAB",
    (p) => p.endsWith(".aab"),
    `SteamGuard_${version}_android-universal.aab`,
  ],
  [
    "LiveContainer IPA",
    (p) => p.endsWith(".ipa"),
    `SteamGuard_${version}_ios-arm64-LiveContainer.ipa`,
  ],
];
const installers = specs.map(([label, predicate, rename]) => {
  const found = files.filter(predicate);
  if (found.length !== 1)
    throw new Error(`Expected exactly one ${label}, found ${found.length}`);
  const name = rename || path.basename(found[0]);
  if (!name.includes(version))
    throw new Error(`Unexpected version for ${label}`);
  return { source: found[0], name };
});
const names = [...installers.map((file) => file.name), "LICENSE.txt"];
const allowed = new Set([...names, "SHA256SUMS"]);
if (readdirSync(output).some((name) => !allowed.has(name)))
  throw new Error(
    "Release directory contains unexpected files; use a clean directory",
  );
for (const file of installers)
  copyFileSync(file.source, path.join(output, file.name));
copyFileSync("LICENSE", path.join(output, "LICENSE.txt"));
const sums = names.sort().map(
  (name) =>
    `${createHash("sha256")
      .update(readFileSync(path.join(output, name)))
      .digest("hex")}  ${name}`,
);
writeFileSync(path.join(output, "SHA256SUMS"), `${sums.join("\n")}\n`);
console.log(
  `Prepared ${specs.length} installers, license and checksums for v${version}`,
);
