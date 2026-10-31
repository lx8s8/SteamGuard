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
  return `SteamGuard ${version}\n\n${body}\n`;
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
