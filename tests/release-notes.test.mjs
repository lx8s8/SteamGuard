import test from "node:test";
import assert from "node:assert/strict";
import { releaseNotes } from "../scripts/release-notes.mjs";
test("release notes contain only the selected version", () => {
  const changelog =
    "# 更新日志\n\n## 1.2.0\n\n- Current feature\n\n## 1.1.0\n\n- Old feature\n";
  const notes = releaseNotes(changelog, "1.2.0");
  assert.match(notes, /Current feature/);
  assert.doesNotMatch(notes, /Old feature|1\.1\.0/);
  assert.throws(() => releaseNotes(changelog, "9.0.0"));
  assert.throws(() => releaseNotes("## 1.2.0\n\n", "1.2.0"));
});
