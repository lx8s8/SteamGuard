import { useEffect, useState, type FormEvent } from "react";
import { Eye, Fingerprint, LoaderCircle, LockKeyhole } from "lucide-react";
import { Modal } from "./Modal";
import { api, errorText } from "./api";
import type { QuickCapabilities, VaultStatus } from "./types";

export function QuickAccessSettings({
  status,
  onChange,
}: {
  status: VaultStatus;
  onChange: () => Promise<void>;
}) {
  const [capabilities, setCapabilities] = useState<QuickCapabilities | null>(
    null,
  );
  const [slot, setSlot] = useState<"preview" | "biometric" | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void api
      .quickCapabilities()
      .then(setCapabilities)
      .catch(() =>
        setCapabilities({
          supported: false,
          biometricAvailable: false,
          label: "指纹 / Face ID",
        }),
      );
  }, []);
  const close = () => {
    if (!busy) {
      setSlot(null);
      setPassword("");
      setError("");
    }
  };
  const configure = async (
    which: "preview" | "biometric",
    enabled: boolean,
  ) => {
    setBusy(true);
    setError("");
    try {
      await api.quickConfigure(which, enabled, password);
      setSlot(null);
      setPassword("");
      await onChange();
    } catch (e) {
      setError(errorText(e));
      await onChange();
    } finally {
      setBusy(false);
    }
  };
  const toggle = (which: "preview" | "biometric", enabled: boolean) => {
    if (enabled) {
      setError("");
      setPassword("");
      setSlot(which);
    } else void configure(which, false);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (slot) void configure(slot, true);
  };
  return (
    <section className="settings-panel quick-settings">
      <div className="panel-title">
        <span className="overview-icon blue">
          <Fingerprint size={22} />
        </span>
        <div>
          <h2>快捷访问</h2>
          <p>选择适合这台手机的打开方式</p>
        </div>
      </div>
      <div className="setting-row">
        <div>
          <h3>免密码预览令牌</h3>
          <p>下次打开直接查看、复制验证码。登录、交易和令牌管理仍需解锁。</p>
        </div>
        <button
          className="access-switch"
          role="switch"
          aria-label="免密码预览令牌"
          aria-checked={!!status.previewEnabled}
          disabled={
            busy || (!status.previewEnabled && !capabilities?.supported)
          }
          onClick={() => toggle("preview", !status.previewEnabled)}
        >
          <span />
        </button>
      </div>
      <div className="setting-row">
        <div>
          <h3>{capabilities?.label || "指纹 / Face ID"} 解锁</h3>
          <p>通过系统认证进入完整保险库，可随时改用主密码。</p>
        </div>
        <button
          className="access-switch"
          role="switch"
          aria-label="设备生物认证解锁"
          aria-checked={!!status.biometricEnabled}
          disabled={
            busy ||
            (!status.biometricEnabled && !capabilities?.biometricAvailable)
          }
          onClick={() => toggle("biometric", !status.biometricEnabled)}
        >
          <span />
        </button>
      </div>
      {capabilities && (
        <p className="access-note">
          {!capabilities.supported
            ? "快捷访问支持 Android 和 iOS；桌面版继续使用主密码。"
            : !capabilities.biometricAvailable
              ? "尚未检测到可用的指纹或 Face ID，请先在系统设置中录入。"
              : "主密码仍用于备份与恢复，请妥善保管。更改系统生物特征后需重新启用认证。"}
        </p>
      )}
      {error && !slot && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {slot && (
        <Modal
          title={slot === "preview" ? "启用免密码预览" : "启用设备认证解锁"}
          onClose={close}
        >
          <div className="access-explanation">
            {slot === "preview" ? <Eye size={24} /> : <Fingerprint size={24} />}
            <p>
              {slot === "preview"
                ? "启用后，能打开此应用的人都能查看、复制验证码。此设置只在这台手机生效，不会开放交易确认或导出权限。"
                : "验证主密码后，将解锁密钥交给系统保护。以后可用指纹、Touch ID 或 Face ID 解锁，不需要重复输入主密码。"}
            </p>
          </div>
          <form onSubmit={submit}>
            <label className="field-label" htmlFor="access-password">
              确认保险库主密码
            </label>
            <input
              id="access-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button
                className="button secondary"
                type="button"
                onClick={close}
                disabled={busy}
              >
                取消
              </button>
              <button className="button primary" disabled={busy || !password}>
                {busy ? (
                  <LoaderCircle size={17} className="spin" />
                ) : (
                  <LockKeyhole size={17} />
                )}
                确认启用
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
