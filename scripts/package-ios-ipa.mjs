import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "Usage: npm run package:ios:ipa -- [device.xcarchive|Device.app] [output.ipa]",
  );
  process.exit(0);
}
if (process.platform !== "darwin")
  throw new Error("Package the iOS device app on macOS.");
if (args.length > 2)
  throw new Error("Expected an archive/app path and optional IPA output path.");

const input = path.resolve(
  args[0] ?? "src-tauri/gen/apple/build/steamguard_iOS.xcarchive",
);
const output = path.resolve(
  args[1] ?? "artifacts/SteamGuard-iOS-arm64-unsigned.ipa",
);
if (!output.endsWith(".ipa"))
  throw new Error("Output must have the .ipa extension.");

let app = input;
if (input.endsWith(".xcarchive")) {
  const applications = path.join(input, "Products/Applications");
  if (!existsSync(applications))
    throw new Error(
      "Archive has no Products/Applications folder. Build the iOS device archive first.",
    );
  const apps = readdirSync(applications).filter((name) =>
    name.endsWith(".app"),
  );
  if (apps.length !== 1)
    throw new Error("Expected exactly one iOS device app in the archive.");
  app = path.join(applications, apps[0]);
}
if (!app.endsWith(".app") || !statSync(app).isDirectory())
  throw new Error(
    "Input must be an extracted .xcarchive or .app directory, not its ZIP.",
  );

const run = (command, params) =>
  execFileSync(command, params, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const info = JSON.parse(
  run("/usr/bin/plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    path.join(app, "Info.plist"),
  ]),
);
if (
  info.DTPlatformName !== "iphoneos" ||
  !info.CFBundleSupportedPlatforms?.includes("iPhoneOS")
) {
  throw new Error(
    "Simulator apps cannot run in LiveContainer. Supply the iPhoneOS device archive.",
  );
}
const executable = info.CFBundleExecutable;
if (!executable || path.basename(executable) !== executable)
  throw new Error("Invalid CFBundleExecutable.");
const binary = path.join(app, executable);
const architectures = run("/usr/bin/xcrun", ["lipo", "-archs", binary])
  .trim()
  .split(/\s+/);
if (!architectures.includes("arm64"))
  throw new Error("The device app must contain arm64 code.");
const build = run("/usr/bin/xcrun", ["vtool", "-show-build", binary]);
if (
  !/^\s*platform IOS\s*$/m.test(build) ||
  /platform IOSSIMULATOR/.test(build)
) {
  throw new Error("The executable is not built for an iOS device.");
}
const commands = run("/usr/bin/xcrun", ["otool", "-l", binary]);
if (
  [...commands.matchAll(/^\s*cryptid\s+(\d+)\s*$/gm)].some((m) => m[1] !== "0")
) {
  throw new Error(
    "The executable is encrypted and cannot be packaged for LiveContainer.",
  );
}

const temp = mkdtempSync(path.join(tmpdir(), "steamguard-ipa-"));
const pending = `${output}.tmp`;
try {
  const payload = path.join(temp, "Payload");
  mkdirSync(payload);
  const copied = path.join(payload, path.basename(app));
  cpSync(app, copied, { recursive: true, verbatimSymlinks: true });
  chmodSync(path.join(copied, executable), 0o755);
  const ipa = path.join(temp, "device.ipa");
  // Keep Payload at the ZIP root; an xcarchive ZIP or renamed ZIP is not an IPA.
  run("/usr/bin/ditto", [
    "-c",
    "-k",
    "--norsrc",
    "--noextattr",
    "--keepParent",
    payload,
    ipa,
  ]);
  const entries = run("/usr/bin/unzip", ["-Z1", ipa]).trim().split("\n");
  const root = `Payload/${path.basename(app)}/`;
  if (
    !entries.includes(`${root}Info.plist`) ||
    !entries.includes(`${root}${executable}`) ||
    entries.some((entry) => !entry.startsWith("Payload/"))
  ) {
    throw new Error(
      "IPA validation failed: expected Payload/<App>.app at the ZIP root.",
    );
  }
  run("/usr/bin/unzip", ["-tq", ipa]);
  mkdirSync(path.dirname(output), { recursive: true });
  copyFileSync(ipa, pending);
  renameSync(pending, output);
  console.log(`IPA ready: ${output}`);
  console.log(
    `Verified: Payload/${path.basename(app)}, iPhoneOS arm64, unencrypted executable, bundle ${info.CFBundleIdentifier}, minimum iOS ${info.MinimumOSVersion}.`,
  );
  console.log(
    "Unsigned IPA: import the .ipa into LiveContainer for device testing; ordinary iOS installation still requires signing.",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
  rmSync(pending, { force: true });
}
