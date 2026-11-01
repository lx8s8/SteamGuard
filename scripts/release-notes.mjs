import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
export function releaseNotes(changelog, version) {
  const sections = changelog.split(/^## /m).slice(1);
  const section = sections.find(
    (part) => part.split(/\r?\n/, 1)[0].trim() === version,
  );
  if (!section) throw new Error(`Missing changelog section for ${version}`);
  const body = section.slice(section.indexOf("\n") + 1).trim();
  if (!body) throw new Error(`Empty changelog section for ${version}`);
  if (/kasen|fingerprints\.json|\.(?:pem|cer)\b|发布者/iu.test(body))
    throw new Error("Release notes contain internal distribution details");
  return `SteamGuard ${version}\n\n${body}\n\n安装包选择：Android 使用 APK，Windows 使用 EXE 或 MSI，macOS 按芯片选择 DMG，iOS / LiveContainer 使用 IPA。\n\n[安装与迁移](https://github.com/lx8s8/SteamGuard/blob/main/docs/INSTALLATION.md) · [备份与恢复](https://github.com/lx8s8/SteamGuard/blob/main/docs/BACKUP.md)\n\n\`SHA256SUMS\` 用于核对下载文件完整性。\n`;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  if (
    process.env.GITHUB_REF_NAME &&
    process.env.GITHUB_REF_NAME !== `v${version}`
  )
    throw new Error("Release tag and application version must match");
  process.stdout.write(
    releaseNotes(readFileSync("CHANGELOG.md", "utf8"), version),
  );
}
