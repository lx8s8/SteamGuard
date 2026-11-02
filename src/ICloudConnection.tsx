import { useEffect, useState } from "react";
import { call, native } from "./api";

export const ICLOUD_ENDPOINT = "steamguard-icloud://default/";
export const isICloudEndpoint = (endpoint: string) => endpoint === ICLOUD_ENDPOINT;
export interface ICloudAvailability {
  supported: boolean;
  configured: boolean;
  available: boolean;
  revision: number;
}
export const icloudStatus = () => call<ICloudAvailability>("icloud_status");
export const icloudWatch = (enabled: boolean) => call<void>("icloud_watch", { enabled });
export function useICloudAvailability() {
  const [status, setStatus] = useState<ICloudAvailability>({ supported: false, configured: false, available: false, revision: 0 });
  useEffect(() => {
    if (!native) return;
    let disposed = false;
    const refresh = () => {
      if (document.hidden) return;
      void icloudStatus().then(next => { if (!disposed && next && typeof next.supported === "boolean") setStatus(next); }).catch(() => {});
    };
    refresh();
    window.addEventListener("steamguard:foreground-ready", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { disposed = true; window.removeEventListener("steamguard:foreground-ready", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, []);
  return status;
}
