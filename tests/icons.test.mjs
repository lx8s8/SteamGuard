import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apple = path.join(root, "src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset");
const android = path.join(root, "src-tauri/gen/android/app/src/main/res");

// Decode the PNG standard directly: an IHDR alpha flag alone cannot tell whether
// resampling accidentally left almost-opaque (254) pixels in an iOS icon.
function png(file) {
  const input = readFileSync(file);
  assert.deepEqual(input.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  let header;
  const parts = [];
  for (let offset = 8; offset < input.length;) {
    const length = input.readUInt32BE(offset);
    const type = input.toString("ascii", offset + 4, offset + 8);
    assert(offset + length + 12 <= input.length, "Truncated PNG chunk");
    const data = input.subarray(offset + 8, offset + length + 8);
    if (type === "IHDR") header = data;
    if (type === "IDAT") parts.push(data);
    offset += length + 12;
  }
  assert(header, "PNG requires an IHDR");
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4);
  assert(width > 0 && height > 0 && width <= 2048 && height <= 2048);
  assert.equal(header[8], 8, "Icon PNG must use 8-bit channels");
  assert([2, 6].includes(header[9]), "Expected RGB or RGBA PNG");
  assert.equal(header[12], 0, "Expected noninterlaced PNG");
  const channels = header[9] === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(parts));
  assert.equal(raw.length, (stride + 1) * height);
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1), filter = raw[start];
    assert(filter <= 4, "Unknown PNG filter");
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      const left = x >= channels ? pixels[i - channels] : 0;
      const above = y ? pixels[i - stride] : 0;
      const diagonal = y && x >= channels ? pixels[i - stride - channels] : 0;
      let prediction = 0;
      if (filter === 1) prediction = left;
      if (filter === 2) prediction = above;
      if (filter === 3) prediction = Math.floor((left + above) / 2);
      if (filter === 4) {
        const p = left + above - diagonal;
        const a = Math.abs(p - left), b = Math.abs(p - above), c = Math.abs(p - diagonal);
        prediction = a <= b && a <= c ? left : b <= c ? above : diagonal;
      }
      pixels[i] = (raw[start + 1 + x] + prediction) & 255;
    }
  }
  const alpha = Buffer.alloc(width * height, 255);
  if (channels === 4) for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3];
  return { width, height, alpha };
}

test("all iOS slots match the asset catalog and are fully opaque, including the store icon", () => {
  const manifest = JSON.parse(readFileSync(path.join(apple, "Contents.json"), "utf8"));
  assert(manifest.images.some(row => row.idiom === "ios-marketing" && row.size === "1024x1024"));
  for (const row of manifest.images) {
    assert(row.filename);
    const image = png(path.join(apple, row.filename));
    const dimensions = row.size.split("x").map(value => Number(value) * Number(row.scale.slice(0, -1)));
    assert.deepEqual([image.width, image.height], dimensions, row.filename);
    assert(image.alpha.every(value => value === 255), `${row.filename} contains a nonopaque pixel`);
  }
});

test("Android adaptive and themed marks fit the safe circle at every density", () => {
  for (const [density, scale] of [["mdpi", 1], ["hdpi", 1.5], ["xhdpi", 2], ["xxhdpi", 3], ["xxxhdpi", 4]]) {
    const directory = path.join(android, `mipmap-${density}`);
    for (const name of ["ic_launcher", "ic_launcher_round"]) {
      const image = png(path.join(directory, `${name}.png`));
      assert.deepEqual([image.width, image.height], [48 * scale, 48 * scale]);
    }
    const background = png(path.join(directory, "ic_launcher_background.png"));
    assert.deepEqual([background.width, background.height], [108 * scale, 108 * scale]);
    assert(background.alpha.every(value => value === 255));
    const foreground = png(path.join(directory, "ic_launcher_foreground.png"));
    const monochrome = png(path.join(directory, "ic_launcher_monochrome.png"));
    assert.deepEqual([foreground.width, foreground.height], [108 * scale, 108 * scale]);
    assert.deepEqual([monochrome.width, monochrome.height], [foreground.width, foreground.height]);
    assert.deepEqual(monochrome.alpha, foreground.alpha, "Themed and color marks must share their shape");
    let visible = 0;
    // One pixel permits edge antialiasing around the standard 66dp safe circle.
    const radius = 33 * scale + 1;
    for (let i = 0; i < foreground.alpha.length; i++) {
      if (foreground.alpha[i] <= 16) continue;
      visible++;
      const x = i % foreground.width + 0.5 - foreground.width / 2;
      const y = Math.floor(i / foreground.width) + 0.5 - foreground.height / 2;
      assert(x * x + y * y <= radius * radius, `${density} mark exceeds the adaptive safe circle`);
    }
    assert(visible > foreground.alpha.length * 0.05, "Adaptive mark must not be empty");
  }
});

test("adaptive and round launcher definitions resolve all platform icon layers", () => {
  for (const version of [26, 33]) {
    for (const filename of ["ic_launcher.xml", "ic_launcher_round.xml"]) {
      const xml = readFileSync(path.join(android, `mipmap-anydpi-v${version}`, filename), "utf8");
      assert.match(xml, /<adaptive-icon\b/);
      for (const name of ["background", "foreground", ...(version >= 33 ? ["monochrome"] : [])]) {
        assert(xml.includes(`<${name} android:drawable="@mipmap/ic_launcher_${name}"`));
      }
    }
  }
  const manifest = readFileSync(path.join(android, "../AndroidManifest.xml"), "utf8");
  assert.match(manifest, /android:icon="@mipmap\/ic_launcher"/);
  assert.match(manifest, /android:roundIcon="@mipmap\/ic_launcher_round"/);
});
