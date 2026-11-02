import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncIosVersions } from "../scripts/ios-versions.mjs";

test("iOS source and both bundle plists use the new version and preserve capabilities", () => {
  const root = mkdtempSync(path.join(tmpdir(), "steamguard-ios-version-"));
  try {
    const project = path.join(root, "src-tauri/gen/apple");
    mkdirSync(path.join(project, "steamguard_iOS"), {recursive:true});
    mkdirSync(path.join(project, "SystemEntriesWidget"));
    writeFileSync(path.join(root, "src-tauri/tauri.conf.json"), JSON.stringify({version:"2.7.3",bundle:{iOS:{bundleVersion:"20703"}}}));
    writeFileSync(path.join(project, "project.yml"), "targets:\n  main:\n    info:\n      properties:\n        CFBundleShortVersionString: 1.5.1\n        CFBundleVersion: '1.5.1'\n  widget:\n    info:\n      properties:\n        CFBundleShortVersionString: 1.5.1\n        CFBundleVersion: '1.5.1'\n");
    const plist = "<plist><dict><key>CFBundleShortVersionString</key><string>1.5.1</string><key>CFBundleVersion</key><string>1.5.1</string><key>SteamGuardAppGroup</key><string>$(STEAMGUARD_APP_GROUP)</string></dict></plist>";
    for(const target of ["steamguard_iOS","SystemEntriesWidget"])writeFileSync(path.join(project,target,"Info.plist"),plist);
    assert.deepEqual(syncIosVersions(root,["--build-number","42"]),{short:"2.7.3",build:"20703.42"});
    for(const target of ["steamguard_iOS","SystemEntriesWidget"]){
      const result=readFileSync(path.join(project,target,"Info.plist"),"utf8");
      assert.match(result,/<key>CFBundleShortVersionString<\/key><string>2.7.3<\/string>/);
      assert.match(result,/<key>CFBundleVersion<\/key><string>20703.42<\/string>/);
      assert.ok(result.includes("$(STEAMGUARD_APP_GROUP)"));
    }
    const spec=readFileSync(path.join(project,"project.yml"),"utf8");
    assert.equal([...spec.matchAll(/CFBundleVersion: "20703.42"/g)].length,2);
    writeFileSync(path.join(root,"src-tauri/tauri.ios.conf.json"),JSON.stringify({version:"3.0.0",bundle:{iOS:{bundleVersion:"300"}}}));
    assert.deepEqual(syncIosVersions(root,["--config",'{"version":"3.2.1","bundle":{"iOS":{"bundleVersion":"321"}}}']),{short:"3.2.1",build:"321"});
    assert.throws(()=>syncIosVersions(root,["--build-number","1; injected"]));
    assert.deepEqual(syncIosVersions(root,["--config",'{"version":"3.2.1-rc.5","bundle":{"iOS":{"bundleVersion":null}}}']),{short:"3.2.1",build:"3.2.1.5"});
    assert.deepEqual(syncIosVersions(root,["--config",'{"version":"3.2.1-beta","bundle":{"iOS":{"bundleVersion":null}}}',"--build-number=0007"]),{short:"3.2.1",build:"3.2.1.7"});
    assert.deepEqual(syncIosVersions(root,["--config",'{"version":"3.2.1+metadata","bundle":{"iOS":{"bundleVersion":"99"}}}']),{short:"3.2.1",build:"99"});
    assert.throws(()=>syncIosVersions(root,["--build-number","4294967296"]));
  }finally{rmSync(root,{recursive:true,force:true});}
});
