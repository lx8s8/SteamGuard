// Public RFC 4226 vector, adjusted per page. Never use these synthetic credentials.
const varint = (value: number) => {
  const bytes: number[] = [];
  do {
    const next = value % 128;
    value = Math.floor(value / 128);
    bytes.push(next | (value ? 128 : 0));
  } while (value);
  return bytes;
};
const field = (id: number, value: Uint8Array | string) => {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  return [id * 8 + 2, ...varint(bytes.length), ...bytes];
};
function page(batch: number, index: number, size: number) {
  const account = Buffer.from([
    ...field(1, `1234567890123456789${index}`),
    ...field(2, `Synthetic ${index + 1}`),
    ...field(3, "Example"),
    0x20,
    1,
    0x28,
    1,
    0x30,
    2,
  ]);
  const bytes = Buffer.from([
    ...field(1, account),
    0x10,
    1,
    0x18,
    size,
    0x20,
    index,
    0x28,
    ...varint(batch),
  ]);
  return `otpauth-migration://offline?data=${encodeURIComponent(bytes.toString("base64"))}`;
}
export const googlePages = [page(77, 0, 3), page(77, 1, 3), page(77, 2, 3)];
export const otherBatchPage = page(78, 1, 3);
export const qrPages = Object.fromEntries([
  ...googlePages.map((uri, index) => [uri, { batch: 77, index, size: 3 }]),
  [otherBatchPage, { batch: 78, index: 1, size: 3 }],
]);
export const ordinaryQr =
  "otpauth://totp/Example:synthetic?secret=GEZDGNBVGY3TQOJQ&issuer=Example";
