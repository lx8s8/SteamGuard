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
const updaterSpecs = [
  ["darwin-aarch64", "_aarch64.app.tar.gz"],
  ["darwin-x86_64", "_x64.app.tar.gz"],
  ["windows-x86_64", "-setup.exe"],
  ["windows-x86_64-nsis", "-setup.exe"],
  ["windows-x86_64-msi", ".msi"],
];
const platforms = {};
for (const [target, suffix] of updaterSpecs) {
  const found = files.filter(p => p.endsWith(suffix));
  if (found.length !== 1) throw new Error(`Expected one updater for ${target}`);
  const name = path.basename(found[0]);
  if (!name.includes(version)) throw new Error(`Unexpected updater version for ${target}`);
  const signature = readFileSync(`${found[0]}.sig`, 'utf8').trim();
  if (!signature || signature.length > 8192 || !/^[A-Za-z0-9+/=]+$/.test(signature)) throw new Error(`Invalid updater signature for ${target}`);
  const decoded = Buffer.from(signature,'base64').toString('utf8');
  if (!decoded.startsWith('untrusted comment:') || !decoded.includes('trusted comment:')) throw new Error(`Invalid updater signature for ${target}`);
  platforms[target] = {signature, url:`https://github.com/lx8s8/SteamGuard/releases/download/v${version}/${name}`};
  if (!installers.some(file => file.name === name)) installers.push({source:found[0], name});
}
const notes = readFileSync('CHANGELOG.md','utf8').split(/^## /m).slice(1).find(part => part.split(/\r?\n/,1)[0].trim() === version);
if (!notes) throw new Error('Missing release notes');
const manifest = { version, notes:notes.slice(notes.indexOf('\n')+1).trim(), platforms };
const names = [...installers.map((file) => file.name), "LICENSE.txt", "latest.json"];
const allowed = new Set([...names, "SHA256SUMS"]);
if (readdirSync(output).some((name) => !allowed.has(name)))
  throw new Error(
    "Release directory contains unexpected files; use a clean directory",
  );
for (const file of installers)
  copyFileSync(file.source, path.join(output, file.name));
copyFileSync("LICENSE", path.join(output, "LICENSE.txt"));
writeFileSync(path.join(output, "latest.json"), JSON.stringify(manifest,null,2)+"\n");
const sums = names.sort().map(
  (name) =>
    `${createHash("sha256")
      .update(readFileSync(path.join(output, name)))
      .digest("hex")}  ${name}`,
);
writeFileSync(path.join(output, "SHA256SUMS"), `${sums.join("\n")}\n`);
console.log(
  `Prepared ${specs.length} installers, updater archives, metadata, license and checksums for v${version}`,
);
