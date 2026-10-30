import {
  writeFileSync,
  mkdirSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const source = process.env.STEAMGUARD_SIGNING;
if (!source)
  throw new Error("STEAMGUARD_SIGNING is required for signed release builds");
const all = JSON.parse(source);
// Mask each value independently: masking a JSON object does not mask its fields.
if (process.env.GITHUB_ACTIONS) {
  for (const group of Object.values(all)) {
    for (const value of Object.values(group))
      console.log(`::add-mask::${value}`);
  }
}
const dir = path.join(
  process.env.RUNNER_TEMP || tmpdir(),
  "steamguard-signing",
);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const platform = process.argv[2];
if (platform === "android") {
  const data = all.android;
  for (const key of ["alias", "storePassword", "keyPassword"]) {
    if (!/^[a-zA-Z0-9_-]+$/.test(data[key]))
      throw new Error("Invalid signing configuration");
  }
  const keystore = path.join(dir, "release.jks");
  writeFileSync(keystore, Buffer.from(data.keystoreBase64, "base64"), {
    mode: 0o600,
  });
  writeFileSync(
    "src-tauri/gen/android/keystore.properties",
    [
      `storeFile=${keystore.replaceAll("\\", "/")}`,
      `storePassword=${data.storePassword}`,
      `keyPassword=${data.keyPassword}`,
      `keyAlias=${data.alias}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
} else if (platform === "windows") {
  const data = all.windows;
  writeFileSync(
    path.join(dir, "release.pfx"),
    Buffer.from(data.pfxBase64, "base64"),
    { mode: 0o600 },
  );
  if (!/^[A-F0-9]{40}$/.test(data.thumbprint))
    throw new Error("Invalid certificate thumbprint");
  writeFileSync(
    path.join(dir, "tauri-signing.json"),
    JSON.stringify({
      bundle: {
        windows: {
          certificateThumbprint: data.thumbprint,
          digestAlgorithm: "sha256",
          timestampUrl: "http://timestamp.digicert.com",
          tsp: true,
        },
      },
    }),
  );
  if (process.env.GITHUB_ENV)
    appendFileSync(process.env.GITHUB_ENV, `STEAMGUARD_SIGNING_DIR=${dir}\n`);
} else throw new Error("Expected android or windows");
console.log(`Prepared ${platform} release signing`);
