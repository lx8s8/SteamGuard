import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
function merge(target, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return source;
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) continue;
    result[key] = value && typeof value === "object" && !Array.isArray(value) ? merge(result[key], value) : value;
  }
  return result;
}
function numericVersion(value) {
  if (typeof value !== "string") throw new Error("An iOS app version is required.");
  const semver = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(value);
  if (!semver) {
    if (/^\d+(?:\.\d+){0,3}$/.test(value)) return value;
    throw new Error("The iOS bundle version must contain only dot-separated integers.");
  }
  const prerelease = semver[4]?.split(".").slice(1).join(".");
  if (prerelease && semver[5]) throw new Error("Use bundle.iOS.bundleVersion for an iOS prerelease with build metadata.");
  const suffix = prerelease || semver[5];
  const result = `${semver[1]}.${semver[2]}.${semver[3]}${suffix ? `.${suffix}` : ""}`;
  if (!/^\d+(?:\.\d+){0,3}$/.test(result)) throw new Error("Use a numeric iOS bundleVersion for this prerelease.");
  return result;
}
// Keep the app/extension stamp aligned with the installed CLI's get_config,
// strip_semver_prerelease_tag and archive build-number handling:
// https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.4/crates/tauri-cli/src/mobile/ios/mod.rs
// https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.4/crates/tauri-cli/src/helpers/mod.rs
// https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.4/crates/tauri-cli/src/mobile/ios/build.rs
export function resolveIosVersions(root = projectRoot, args = []) {
  const configDir = path.join(root, "src-tauri");
  let config = readJson(path.join(configDir, "tauri.conf.json"));
  const platform = path.join(configDir, "tauri.ios.conf.json");
  if (existsSync(platform)) config = merge(config, readJson(platform));
  let buildNumber;
  for (let index = 0; index < args.length && args[index] !== "--"; index++) {
    const arg = args[index];
    if (arg === "--config" || arg === "-c" || arg.startsWith("--config=")) {
      const input = arg.startsWith("--config=") ? arg.slice(9) : args[++index];
      if (!input) throw new Error("Missing iOS --config value.");
      // This repository uses JSON configuration. Fail closed instead of silently
      // stamping a different extension version for an unreadable override.
      const override = input.trim().startsWith("{") ? JSON.parse(input) : readJson(path.resolve(root, input));
      config = merge(config, override);
    } else if (arg === "--build-number" || arg.startsWith("--build-number=")) {
      buildNumber = arg.startsWith("--build-number=") ? arg.slice(15) : args[++index];
      if (!/^\d+$/.test(buildNumber ?? "") || !Number.isSafeInteger(Number(buildNumber)) || Number(buildNumber) > 0xffffffff) throw new Error("Invalid iOS build number.");
      buildNumber = String(Number(buildNumber)); // clap parses this as a u32.
    }
  }
  let version = config.version;
  if (typeof version === "string" && version.endsWith(".json")) version = readJson(path.resolve(configDir, version)).version;
  const semver = typeof version === "string" && /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(version);
  if (!semver) throw new Error("Use a semver app version in the Tauri configuration.");
  // get_config truncates CFBundleShortVersionString to the first 3 numbers,
  // even when an explicit bundleVersion avoids an app build-metadata suffix.
  if (semver[4]?.includes(".") && semver[5]) throw new Error("Use a version without combined prerelease and build metadata for this Tauri CLI.");
  const short = `${semver[1]}.${semver[2]}.${semver[3]}`;
  let build = numericVersion(config.bundle?.iOS?.bundleVersion ?? version);
  if (buildNumber !== undefined) build += `.${buildNumber}`;
  return { short, build };
}
export function syncIosVersions(root = projectRoot, args = []) {
  const versions = resolveIosVersions(root, args);
  const project = path.join(root, "src-tauri/gen/apple");
  const spec = path.join(project, "project.yml");
  if (!existsSync(spec)) return versions;
  const save = (file, text) => { if (readFileSync(file, "utf8") !== text) writeFileSync(file, text); };
  const source = readFileSync(spec, "utf8");
  save(spec, source.replace(/^(\s*CFBundleShortVersionString:)\s*.*$/gm, `$1 "${versions.short}"`).replace(/^(\s*CFBundleVersion:)\s*.*$/gm, `$1 "${versions.build}"`));
  for (const name of ["steamguard_iOS/Info.plist", "SystemEntriesWidget/Info.plist"]) {
    const file = path.join(project, name);
    if (!existsSync(file)) continue;
    let text = readFileSync(file, "utf8");
    for (const [key, value] of [["CFBundleShortVersionString", versions.short], ["CFBundleVersion", versions.build]]) {
      const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`, "g");
      if ([...text.matchAll(pattern)].length !== 1) throw new Error(`Expected exactly one ${key} in ${name}.`);
      text = text.replace(pattern, `$1${value}$2`);
    }
    save(file, text);
  }
  return versions;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const versions = syncIosVersions(projectRoot, process.argv.slice(2));
  console.log(`iOS app and widget versions: ${versions.short} (${versions.build})`);
}
