import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
const target=process.argv[2];
if (!['aarch64-apple-darwin','x86_64-apple-darwin','x86_64-pc-windows-msvc'].includes(target)) throw new Error('Unsupported updater target');
const {version}=JSON.parse(readFileSync('package.json','utf8'));
const directory=`src-tauri/target/${target}/release/bundle`;
mkdirSync('artifacts',{recursive:true});
if (target.endsWith('apple-darwin')) {
 const arch=target.startsWith('aarch64')?'aarch64':'x64';
 const name=`SteamGuard_${version}_${arch}.app.tar.gz`;
 for(const extension of ['', '.sig']) copyFileSync(path.join(directory,'macos','SteamGuard.app.tar.gz'+extension),path.join('artifacts',name+extension));
}
// Windows updater is the same signed NSIS installer, and its .sig is uploaded beside it.
