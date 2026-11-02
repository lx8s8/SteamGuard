import { t as translate } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, ImagePlus, X } from "lucide-react";
import { api, errorText } from "./api";

export function QrScanner({ onScan, title = translate("扫描二维码"), buttonLabel = translate("扫码") }: { onScan: (value: string) => void; title?: string; buttonLabel?: string }) {
  const [nativeCamera, setNativeCamera] = useState(false);
  const [active, setActive] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const video = useRef<HTMLVideoElement>(null), picker = useRef<HTMLInputElement>(null);
  const stream = useRef<MediaStream | null>(null), cancel = useRef<(() => Promise<void>) | null>(null), epoch = useRef(0);
  const stop = () => { epoch.current++; stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; void cancel.current?.().catch(() => {}); cancel.current = null; document.body.classList.remove("qr-camera-active"); document.documentElement.classList.remove("qr-camera-active"); setActive(false); setNativeCamera(false); setBusy(false); };
  useEffect(() => { const hidden = () => { if (document.hidden) stop(); }; document.addEventListener("visibilitychange", hidden); return () => { stop(); document.removeEventListener("visibilitychange", hidden); }; }, []);
  const scan = async () => {
    stop(); const generation = epoch.current; setBusy(true); setError(""); setActive(true);
    try {
      if (await api.importCameraSupported()) {
        setNativeCamera(true);
        if (generation !== epoch.current) return;
        const scanner = await import("@tauri-apps/plugin-barcode-scanner");
        let permission = await scanner.checkPermissions(); if (permission !== "granted") permission = await scanner.requestPermissions();
        if (generation !== epoch.current) return;
        if (permission !== "granted") throw new Error(translate("相机权限未开启，请允许相机访问或选择图片"));
        document.body.classList.add("qr-camera-active"); document.documentElement.classList.add("qr-camera-active"); cancel.current = scanner.cancel;
        const result = await scanner.scan({ windowed: true, cameraDirection: "back", formats: [scanner.Format.QRCode] });
        if (generation === epoch.current) { if (!result.content || result.content.length > 65536) throw new Error(translate("二维码内容无效")); onScan(result.content); }
      } else {
        const camera = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (generation !== epoch.current) { camera.getTracks().forEach(track => track.stop()); return; }
        stream.current = camera;
        // The video is mounted once active=true; wait a frame for React to attach its ref.
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        if (!video.current) { camera.getTracks().forEach(track => track.stop()); throw new Error(translate("相机预览不可用")); }
        video.current.srcObject = camera; await video.current.play();
        const { readQrPixels } = await import("./qr-reader");
        const canvas = document.createElement("canvas"), context = canvas.getContext("2d", { willReadFrequently: true }); if (!context) throw new Error(translate("无法读取相机画面"));
        const started = Date.now();
        try {
          while (generation === epoch.current && Date.now() - started < 90000) {
            const v = video.current; if (!v) break;
            if (v.videoWidth && v.readyState >= 2) {
              const scale = Math.min(1, 1600 / Math.max(v.videoWidth, v.videoHeight)); canvas.width = Math.round(v.videoWidth * scale); canvas.height = Math.round(v.videoHeight * scale); context.drawImage(v, 0, 0, canvas.width, canvas.height);
              const pixels = context.getImageData(0, 0, canvas.width, canvas.height); let values: string[];
              try { values = await readQrPixels(pixels, true); } finally { pixels.data.fill(0); }
              if (generation !== epoch.current) return;
              if (values.length > 1) throw new Error(translate("请一次扫描一张二维码"));
              if (values[0]) { if (values[0].length > 65536) throw new Error(translate("二维码内容过长")); onScan(values[0]); return; }
            }
            await new Promise(resolve => setTimeout(resolve, 300));
          }
          if (generation === epoch.current) throw new Error(translate("扫描超时，请重试或选择图片"));
        } finally { context.clearRect(0, 0, canvas.width, canvas.height); canvas.width = canvas.height = 0; }
      }
    } catch (e) { if (generation === epoch.current) setError(errorText(e)); }
    finally { if (generation === epoch.current) stop(); }
  };
  return <div className="generic-scanner">
    <div className="scanner-actions"><button className="button secondary" type="button" disabled={busy} onClick={() => void scan()}><Camera size={17} />{buttonLabel}</button><button className="button secondary" type="button" disabled={busy} onClick={() => picker.current?.click()}><ImagePlus size={17} />{translate("选择二维码图片")}</button></div>
    <input ref={picker} className="visually-hidden" type="file" accept="image/*" aria-label={translate("读取二维码图片")} onChange={async event => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; const generation = epoch.current; setBusy(true); setError(""); try { const { readAnyQrImage } = await import("./qr-reader"); const values = await readAnyQrImage(file); if (generation !== epoch.current) return; if (values.length !== 1 || values[0].length > 65536) throw new Error(translate("请选择只包含一张有效二维码的图片")); onScan(values[0]); } catch (e) { if (generation === epoch.current) setError(errorText(e)); } finally { if (generation === epoch.current) setBusy(false); } }} />
    {error && <p className="form-error" role="alert">{error}</p>}
    {active && createPortal(<div className="qr-camera-overlay" role="dialog" aria-label={title}><div><h2>{title}</h2></div>{!nativeCamera && <video ref={video} autoPlay playsInline muted aria-label={translate("相机预览")} />}<button className="button secondary" onClick={stop}><X size={19} />{translate("停止扫描")}</button></div>, document.body)}
  </div>;
}
export function SteamQrScanner({ onScan }: { onScan: (url: string) => void }) {
  return <QrScanner title={translate("扫描 Steam 登录二维码")} onScan={value => { let url: URL; try { url = new URL(value); } catch { throw new Error(translate("请扫描 Steam 登录二维码")); } if (url.protocol !== "https:" || url.hostname !== "s.team" || url.port || url.username || url.password || !/^\/q\/[1-9]\d*\/\d+$/.test(url.pathname) || url.search || url.hash) throw new Error(translate("请扫描有效的 Steam 登录二维码")); onScan(url.toString()); }} />;
}
