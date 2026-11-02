// Read the release identity from the runner secret; never print or upload it.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
const source = process.env.STEAMGUARD_UPDATER;
if (!source) throw new Error('Updater signing identity is required for official desktop releases');
const { privateKey, password } = JSON.parse(source);
if (typeof privateKey !== 'string' || !privateKey || typeof password !== 'string') throw new Error('Invalid updater signing configuration');
if (!process.env.GITHUB_ENV) throw new Error('This script runs only inside a CI job');
for (const value of [privateKey, password]) if (value) console.log(`::add-mask::${value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`);
for (const [name, value] of Object.entries({ TAURI_SIGNING_PRIVATE_KEY: privateKey, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password })) {
 const delimiter = `STEAMGUARD_${randomBytes(16).toString('hex')}`;
 appendFileSync(process.env.GITHUB_ENV, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}
const directory = process.env.STEAMGUARD_SIGNING_DIR || path.join(process.env.RUNNER_TEMP || tmpdir(), 'steamguard-signing');
mkdirSync(directory, {recursive:true,mode:0o700});
const configPath = path.join(directory, 'tauri-signing.json');
let config = {};
try { config=JSON.parse(readFileSync(configPath,'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
config.bundle={...config.bundle,createUpdaterArtifacts:true};
writeFileSync(configPath, JSON.stringify(config), {mode:0o600});
appendFileSync(process.env.GITHUB_ENV, `STEAMGUARD_SIGNING_DIR=${directory}\n`);
