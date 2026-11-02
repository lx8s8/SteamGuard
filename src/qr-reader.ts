import { t as translate } from "./i18n";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

// Ship the matching decoder with the app. Scanning never downloads code from a CDN.
prepareZXingModule({ overrides: { locateFile: () => wasmUrl } });

export async function readQrPixels(pixels: ImageData, all = false): Promise<string[]> {
  const results = await readBarcodes(pixels, {
    formats: ["QRCode"],
    tryHarder: true,
    maxNumberOfSymbols: 128,
  });
  return [
    ...new Set(
      results
        .map((r) => r.text)
        .filter(
          (text) =>
            all || text.startsWith("otpauth://") ||
            text.startsWith("otpauth-migration://"),
        ),
    ),
  ];
}

export async function readQrImage(file: File, all = false): Promise<string[]> {
  if (file.size === 0 || file.size > 12 * 1024 * 1024)
    throw new Error(translate("请选择不超过 12 MB 的二维码图片"));
  if (
    file.type &&
    ![
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/bmp",
      "image/gif",
      "image/heic",
      "image/heif",
    ].includes(file.type)
  )
    throw new Error(translate("请选择 PNG、JPEG、WebP 或相册照片"));
  const image = new Image();
  const url = URL.createObjectURL(file);
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () =>
        reject(new Error(translate("无法打开图片，请使用 PNG、JPEG 或 WebP 图片")));
      image.src = url;
    });
    if (
      !image.naturalWidth ||
      !image.naturalHeight ||
      image.naturalWidth * image.naturalHeight > 40_000_000
    )
      throw new Error(translate("图片分辨率过大，请裁剪到二维码区域后重试"));
    const scale = Math.min(
      1,
      4096 / Math.max(image.naturalWidth, image.naturalHeight),
      Math.sqrt(12_000_000 / (image.naturalWidth * image.naturalHeight)),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error(translate("当前设备无法读取图片"));
    try {
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      try {
        return await readQrPixels(pixels, all);
      } finally {
        pixels.data.fill(0);
      }
    } finally {
      context.clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = canvas.height = 0;
    }
  } finally {
    image.src = "";
    URL.revokeObjectURL(url);
  }
}

export const readAnyQrImage = (file: File) => readQrImage(file, true);
