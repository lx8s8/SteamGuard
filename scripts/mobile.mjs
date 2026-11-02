import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncIosVersions } from "./ios-versions.mjs";

const env = { ...process.env };
if (process.platform === "darwin") {
  const java = "/Applications/Android Studio.app/Contents/jbr/Contents/Home";
  if (!env.JAVA_HOME && existsSync(java)) env.JAVA_HOME = java;
  const sdk = path.join(os.homedir(), "Library/Android/sdk");
  if (!env.ANDROID_HOME && existsSync(sdk)) env.ANDROID_HOME = sdk;
}
if (!env.NDK_HOME && env.ANDROID_HOME) {
  const ndks = path.join(env.ANDROID_HOME, "ndk");
  if (existsSync(ndks)) {
    const versions = readdirSync(ndks).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    );
    if (versions.length) env.NDK_HOME = path.join(ndks, versions.at(-1));
  }
}
const cli = path.resolve("node_modules/@tauri-apps/cli/tauri.js");
const args = process.argv.slice(2);
if (args[0] === "ios" && ["build", "dev", "run"].includes(args[1]) && !args.includes("--help") && !args.includes("-h")) {
  syncIosVersions(process.cwd(), args.slice(2));
}
const result = spawnSync(process.execPath, [cli, ...args], {
  env,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
