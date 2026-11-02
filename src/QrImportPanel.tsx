import { t as translate } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, ImagePlus, RotateCcw, ScanLine, X } from "lucide-react";
import { api, errorText } from "./api";
import type { ImportPreview, QrImportProgress } from "./types";

let activeCameraOwner: symbol | null = null;

export function QrImportPanel({
  onPreview,
}: {
  onPreview: (preview: ImportPreview) => void;
}) {
  const [payloads, setPayloads] = useState<string[]>([]);
  const [progress, setProgress] = useState<QrImportProgress | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [camera, setCamera] = useState<"native" | "desktop" | null>(null);
  const [nativeCamera, setNativeCamera] = useState<boolean | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const abort = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const previewId = useRef<string | null>(null);
  const scanningNative = useRef(false);
  const cancelNative = useRef<(() => Promise<void>) | null>(null);
  const cameraOwner = useRef(Symbol());
  const stop = () => {
    abort.current?.abort();
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (scanningNative.current) {
      scanningNative.current = false;
      void cancelNative.current?.().catch(() => {});
    }
    if (activeCameraOwner === cameraOwner.current) {
      activeCameraOwner = null;
      document.documentElement.classList.remove("qr-camera-active");
      document.body.classList.remove("qr-camera-active");
    }
  };
  useEffect(() => {
    let live = true;
    void api
      .importCameraSupported()
      .then((value) => {
        if (live) setNativeCamera(value);
      })
      .catch(() => {
        if (live) setNativeCamera(false);
      });
    const hidden = () => {
      if (document.visibilityState === "hidden") stop();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      live = false;
      generation.current++;
      stop();
      if (previewId.current)
        void api.discardPreview(previewId.current).catch(() => {});
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  const add = async (codes: string[], epoch: number) => {
    const next = [...new Set([...payloads, ...codes])];
    if (!codes.length)
      throw new Error(translate("未找到验证器二维码，请靠近二维码或裁剪图片后重试"));
    if (next.length === payloads.length) {
      setMessage(translate("这张二维码已经收集，请切换到下一张。"));
      return;
    }
    const result = await api.qrPreview(next);
    if (epoch !== generation.current) {
      if (result.preview)
        void api.discardPreview(result.preview.previewId).catch(() => {});
      return;
    }
    if (previewId.current && previewId.current !== result.preview?.previewId)
      void api.discardPreview(previewId.current).catch(() => {});
    previewId.current = result.preview?.previewId ?? null;
    setPayloads(next);
    setProgress(result);
    setMessage(
      result.duplicateCodes ? translate("已忽略重复的二维码。") : translate("二维码已在本机识别。"),
    );
  };
  const images = async (files: File[]) => {
    if (!files.length) return;
    if (files.length > 128) {
      setError(translate("一次最多选择 128 张图片"));
      return;
    }
    const epoch = generation.current;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const { readQrImage } = await import("./qr-reader");
      const codes: string[] = [];
      for (const file of files) {
        if (epoch !== generation.current) return;
        const found = await readQrImage(file);
        if (!found.length)
          throw new Error(
            translate("有图片未找到验证器二维码，请重新选择清晰的二维码图片"),
          );
        codes.push(...found);
      }
      await add(codes, epoch);
    } catch (e) {
      if (epoch === generation.current) setError(errorText(e));
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  };
  const scan = async () => {
    const epoch = generation.current;
    const controller = new AbortController();
    abort.current = controller;
    activeCameraOwner = cameraOwner.current;
    setBusy(true);
    setError("");
    setMessage("");
    let timedOut = false;
    let importing = false;
    let permissionDenied = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      stop();
    }, 90_000);
    try {
      let codes: string[];
      const cancelled = new Promise<never>((_, reject) =>
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error(translate("扫描已停止"))),
          { once: true },
        ),
      );
      void cancelled.catch(() => {});
      if (nativeCamera) {
        const scanner = await import("@tauri-apps/plugin-barcode-scanner");
        let permission = await scanner.checkPermissions();
        if (permission !== "granted")
          permission = await scanner.requestPermissions();
        if (permission !== "granted") {
          permissionDenied = true;
          throw new Error(
            translate("相机权限未开启，请在系统设置中允许相机访问，或选择二维码图片"),
          );
        }
        if (controller.signal.aborted) return;
        cancelNative.current = scanner.cancel;
        scanningNative.current = true;
        setCamera("native");
        document.documentElement.classList.add("qr-camera-active");
        document.body.classList.add("qr-camera-active");
        const result = await Promise.race([
          scanner.scan({
            windowed: true,
            cameraDirection: "back",
            formats: [scanner.Format.QRCode],
          }),
          cancelled,
        ]);
        codes = [result.content];
      } else {
        if (!navigator.mediaDevices?.getUserMedia)
          throw new Error(translate("当前环境无法打开相机，请选择二维码图片导入"));
        setCamera("desktop");
        const pendingMedia = navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: "environment",
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
        // A permission prompt can resolve after the user closes the scanner.
        void pendingMedia
          .then((late) => {
            if (controller.signal.aborted)
              late.getTracks().forEach((t) => t.stop());
          })
          .catch(() => {});
        const media = await Promise.race([pendingMedia, cancelled]);
        if (controller.signal.aborted) return;
        stream.current = media;
        // Wait for React to attach the video element before starting the stream.
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        if (!video.current) return;
        video.current.srcObject = media;
        await Promise.race([video.current.play(), cancelled]);
        const { readQrPixels } = await import("./qr-reader");
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context)
          throw new Error(translate("当前环境无法读取相机画面，请使用图片导入"));
        codes = [];
        while (!controller.signal.aborted && !codes.length) {
          const frame = video.current;
          if (!frame) break;
          canvas.width = frame.videoWidth;
          canvas.height = frame.videoHeight;
          if (canvas.width && canvas.height) {
            context.drawImage(frame, 0, 0);
            const pixels = context.getImageData(
              0,
              0,
              canvas.width,
              canvas.height,
            );
            try {
              codes = await readQrPixels(pixels);
            } finally {
              pixels.data.fill(0);
            }
          }
          if (!codes.length)
            await Promise.race([
              new Promise<void>((resolve) => setTimeout(resolve, 250)),
              cancelled,
            ]);
        }
        context.clearRect(0, 0, canvas.width, canvas.height);
        canvas.width = canvas.height = 0;
      }
      if (!controller.signal.aborted && epoch === generation.current) {
        importing = true;
        await add(codes, epoch);
      }
    } catch (e) {
      if (epoch === generation.current) {
        const name = e instanceof DOMException ? e.name : "";
        if (!controller.signal.aborted)
          setError(
            importing || permissionDenied
              ? errorText(e)
              : name === "NotAllowedError"
                ? translate("相机权限被拒绝，请在系统设置中允许相机访问，或选择二维码图片")
                : name === "NotFoundError" || name === "NotReadableError"
                  ? translate("相机不可用或正被占用，请关闭其他相机应用，或选择二维码图片")
                  : nativeCamera
                    ? translate("相机未能完成扫描，请检查相机权限后重试，或选择二维码图片")
                    : errorText(e),
          );
        else
          setMessage(
            timedOut
              ? translate("扫描超时，已关闭相机。可以重试或选择二维码图片。")
              : translate("相机已关闭，已收集的二维码仍保留。"),
          );
      }
    } finally {
      clearTimeout(timeout);
      stop();
      if (epoch === generation.current) {
        setCamera(null);
        setBusy(false);
      }
    }
  };
  return (
    <section className="qr-import" aria-label={translate("扫码导入令牌")}>
      <p className="dialog-intro">{translate("Google Authenticator：转移账号 → 导出账号。按顺序或乱序扫描这次导出的所有二维码，收齐后统一导入。也支持其他验证器的标准 OTP 设置码。")}</p>
      <input
        ref={picker}
        type="file"
        accept="image/*"
        multiple
        className="visually-hidden"
        aria-label={translate("选择二维码图片")}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          void images(files);
        }}
      />
      <div className="qr-import-actions">
        <button
          className="button primary"
          disabled={busy || nativeCamera === null}
          onClick={() => void scan()}
        >
          <Camera size={18} />
          {payloads.length ? translate("继续扫码") : translate("打开相机扫码")}
        </button>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => picker.current?.click()}
        >
          <ImagePlus size={18} />{translate("选择二维码图片")}</button>
      </div>
      <p className="form-hint">{translate("可一次选择多张图片，也能读取一张图片中的多个码。Google 多张二维码请使用同一次导出的全部图片。")}</p>
      {camera === "desktop" && (
        <div className="qr-camera-preview">
          <video ref={video} autoPlay playsInline muted aria-label={translate("相机预览")} />
          <button className="button secondary" onClick={stop}>{translate("停止扫描")}</button>
        </div>
      )}
      {camera === "native" &&
        createPortal(
          <div
            className="qr-camera-overlay"
            role="dialog"
            aria-label={translate("相机扫码")}
          >
            <div>
              <h2>{translate("扫描验证器二维码")}</h2>
              <p>
                {progress?.source === "google"
                  ? translate("已收集 {{received}}/{{expected}} 张，请切换到下一张", { received: progress.received, expected: progress.expected })
                  : translate("将二维码放入取景框")}
              </p>
            </div>
            <div className="qr-camera-frame">
              <ScanLine size={36} />
            </div>
            <button className="button secondary" onClick={stop}>
              <X size={20} />{translate("停止扫描")}</button>
          </div>,
          document.body,
        )}
      {progress && (
        <div className="qr-import-progress" role="status">
          <strong>
            {progress.source === "google"
              ? translate("Google 导出：已收集 {{received}}/{{expected}} 张", { received: progress.received, expected: progress.expected })
              : translate("已收集 {{received}} 张 OTP 二维码", { received: progress.received })}
          </strong>
          <p>{translate("识别到 {{tokenCount}} 个令牌{{value2}}", { tokenCount: progress.tokenCount, value2: progress.complete
              ? translate("，可以预览并确认导入。")
              : translate("，还缺第 {{value1}} 张，请继续扫描。", { value1: progress.missing.join("、") }) })}</p>
          {progress.source === "google" && (
            <progress
              value={progress.received}
              max={progress.expected}
              aria-label={translate("Google 二维码收集进度")}
            />
          )}
        </div>
      )}
      {message && (
        <p className="backup-message" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button
          className="button secondary"
          disabled={busy || !payloads.length}
          onClick={() => {
            generation.current++;
            stop();
            if (previewId.current)
              void api.discardPreview(previewId.current).catch(() => {});
            previewId.current = null;
            setPayloads([]);
            setProgress(null);
            setError("");
            setMessage("");
          }}
        >
          <RotateCcw size={16} />{translate("清空本次收集")}</button>
        <button
          className="button primary"
          disabled={busy || !progress?.complete || !progress.preview}
          onClick={() => {
            if (progress?.preview) {
              previewId.current = null;
              onPreview(progress.preview);
            }
          }}
        >{translate("预览令牌")}</button>
      </div>
    </section>
  );
}
