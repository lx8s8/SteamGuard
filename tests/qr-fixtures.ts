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

const googleV2TokenNames = Array.from(
  { length: 22 },
  (_, index) => `Synthetic V2 ${index + 1}`,
);
const googleV2PageNames = [
  googleV2TokenNames.slice(0, 10),
  googleV2TokenNames.slice(10, 20),
  googleV2TokenNames.slice(20),
];
// Synthetic iOS-shaped export: version 2, three pages, no batch_id (field 5).
// Each secret derives from the public RFC 4226 vector with a synthetic suffix.
export const googleV2Pages = googleV2PageNames.map((names, index) => {
  const accounts = names.flatMap((name) =>
    field(
      1,
      Buffer.from([
        ...field(1, `12345678901234567890:${name}`),
        ...field(2, name),
        ...field(3, "Example"),
        0x20,
        1,
        0x28,
        1,
        0x30,
        2,
      ]),
    ),
  );
  const bytes = Buffer.from([...accounts, 0x10, 2, 0x18, 3, 0x20, index]);
  return `otpauth-migration://offline?data=${encodeURIComponent(bytes.toString("base64"))}`;
});

export type QrPageFixture = {
  version: number;
  batch?: number;
  index: number;
  size: number;
  names: string[];
};
export const qrPages: Record<string, QrPageFixture> = Object.fromEntries([
  ...googlePages.map((uri, index) => [
    uri,
    { version: 1, batch: 77, index, size: 3, names: [`Synthetic ${index + 1}`] },
  ]),
  [
    otherBatchPage,
    { version: 1, batch: 78, index: 1, size: 3, names: ["Synthetic 2"] },
  ],
  ...googleV2Pages.map((uri, index) => [
    uri,
    { version: 2, index, size: 3, names: googleV2PageNames[index] },
  ]),
]);
export const ordinaryQr =
  "otpauth://totp/Example:synthetic?secret=GEZDGNBVGY3TQOJQ&issuer=Example";
