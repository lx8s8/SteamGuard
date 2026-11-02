// Keep every platform icon derived from the same editable SVG sources.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const staging=mkdtempSync(path.join(tmpdir(),'steamguard-icons-'));
const cli=path.join(root,'node_modules/@tauri-apps/cli/tauri.js');
function generate(input,output,extra=[]) {
 const result=spawnSync(process.execPath,[cli,'icon',input,'--output',output,...extra],{cwd:root,stdio:'inherit'});
 if(result.status!==0) throw new Error('Icon generation failed');
}
function copy(source,destination) {mkdirSync(path.dirname(destination),{recursive:true});copyFileSync(source,destination);}
function canonicalIcns(file) {
 // Tauri emits identical payloads in nondeterministic hash-map order. ICNS blocks
 // are keyed by their four-byte type; stable ordering avoids binary churn in Git.
 const bytes=readFileSync(file), blocks=[];
 if(bytes.toString('ascii',0,4)!=='icns' || bytes.readUInt32BE(4)!==bytes.length) throw new Error('Invalid ICNS header');
 for(let offset=8;offset<bytes.length;) {
  if(offset+8>bytes.length) throw new Error('Truncated ICNS block');
  const length=bytes.readUInt32BE(offset+4);
  if(length<8 || offset+length>bytes.length) throw new Error('Invalid ICNS block length');
  blocks.push(bytes.subarray(offset,offset+length)); offset+=length;
 }
 blocks.sort((a,b)=>Buffer.compare(a.subarray(0,4),b.subarray(0,4)));
 writeFileSync(file,Buffer.concat([bytes.subarray(0,8),...blocks]));
}
try {
 const generated=path.join(staging,'platforms');
 generate('assets/brand/icon-manifest.json',generated);
 canonicalIcns(path.join(generated,'icon.icns'));
 const desktop=path.join(root,'src-tauri/icons');
 for(const entry of readdirSync(generated,{withFileTypes:true})) if(entry.isFile()) copy(path.join(generated,entry.name),path.join(desktop,entry.name));
 const apple=path.join(root,'src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset');
 const appleManifest=JSON.parse(readFileSync(path.join(apple,'Contents.json'),'utf8'));
 // Apple requires an opaque square. Export from a full-bleed vector rather than
 // compositing the desktop squircle PNG (which would leave flat-colored corners).
 const iosSvg=readFileSync(path.join(root,'assets/brand/app-icon.svg'),'utf8').replace(/(<rect[^>]*?)\s+rx="[^"]*"/,'$1');
 const iosSource=path.join(staging,'ios-square.svg');
 writeFileSync(iosSource,iosSvg);
 const sizes=[...new Set(appleManifest.images.filter(image=>image.filename).map(image=>Math.round(parseFloat(image.size)*parseFloat(image.scale))))];
 const iosOutput=path.join(staging,'opaque-ios');
 generate(iosSource,iosOutput,sizes.flatMap(size=>['--png',String(size)]));
 for(const {filename,size,scale} of appleManifest.images) {
  if(!filename) continue;
  const pixels=Math.round(parseFloat(size)*parseFloat(scale));
  copy(path.join(iosOutput,`${pixels}x${pixels}.png`),path.join(apple,filename));
 }
 const android=path.join(root,'src-tauri/gen/android/app/src/main/res');
 for(const density of readdirSync(path.join(generated,'android'))) {
  for(const name of readdirSync(path.join(generated,'android',density))) copy(path.join(generated,'android',density,name),path.join(android,density,name));
 }
 for(const [qualifier,monochrome] of [['mipmap-anydpi-v26',false],['mipmap-anydpi-v33',true]]) {
  const xml=`<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n  <background android:drawable="@mipmap/ic_launcher_background"/>\n  <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n${monochrome?'  <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>\n':''}</adaptive-icon>\n`;
  mkdirSync(path.join(android,qualifier),{recursive:true});
  for(const name of ['ic_launcher.xml','ic_launcher_round.xml']) writeFileSync(path.join(android,qualifier,name),xml);
 }
 writeFileSync(path.join(android,'values/ic_launcher_background.xml'),'<resources>\n    <color name="ic_launcher_background">#6059DE</color>\n</resources>\n');
 const tray=path.join(staging,'tray');
 generate('assets/brand/tray.svg',tray,['--png','44']);
 copy(path.join(tray,'44x44.png'),path.join(desktop,'tray.png'));
 copy(path.join(root,'assets/brand/app-icon.svg'),path.join(root,'public/favicon.svg'));
 console.log('Updated desktop, iOS, Android adaptive/monochrome, tray and browser icons.');
} finally {rmSync(staging,{recursive:true,force:true});}
