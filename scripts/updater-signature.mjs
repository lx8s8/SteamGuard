// Minisign's ED format: BLAKE2b-512 payload + Ed25519, plus a signed trusted comment.
// Verify in the collector too, so a bad/mismatched runner artifact cannot be published.
import { createHash, createPublicKey, verify } from 'node:crypto';

function decode(value) {
  if (typeof value !== 'string' || !value || value.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Invalid updater encoding');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('Invalid updater encoding');
  return bytes;
}
export function verifyUpdaterSignature(payload, signature, publicKey, version) {
  const keyLines = decode(publicKey).toString('utf8').trimEnd().split(/\r?\n/);
  const lines = decode(signature).toString('utf8').trimEnd().split(/\r?\n/);
  if (keyLines.length !== 2 || !keyLines[0].startsWith('untrusted comment: ') || lines.length !== 4 || !lines[0].startsWith('untrusted comment: ') || !lines[2].startsWith('trusted comment: ')) throw new Error('Invalid updater signature');
  const key = decode(keyLines[1]), file = decode(lines[1]), global = decode(lines[3]);
  if (key.length !== 42 || key.subarray(0, 2).toString() !== 'Ed' || file.length !== 74 || file.subarray(0, 2).toString() !== 'ED' || global.length !== 64 || !key.subarray(2, 10).equals(file.subarray(2, 10))) throw new Error('Invalid updater signing identity');
  const trusted = lines[2].slice('trusted comment: '.length);
  const versions = trusted.split('\t').filter(field => field.startsWith('version:')).map(field => field.slice(8));
  if (versions.length !== 1 || versions[0] !== version) throw new Error('Updater signature version mismatch');
  const ed25519 = createPublicKey({key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki'});
  if (!verify(null, createHash('blake2b512').update(payload).digest(), ed25519, file.subarray(10)) || !verify(null, Buffer.concat([file.subarray(10), Buffer.from(trusted)]), ed25519, global)) throw new Error('Updater signature verification failed');
}
