import { memo } from "react";
import {
  ArrowRight,
  Check,
  Clock3,
  Copy,
  Ellipsis,
  LockKeyhole,
  LogIn,
  Pin,
} from "lucide-react";
import { t as translate } from "./i18n";
import { TokenAvatar } from "./TokenAvatar";
import { OtpProgress } from "./OtpProgress";
import { OtpCode } from "./OtpCode";
import type { TokenView } from "./types";

export interface TokenCardProps {
  token: TokenView;
  unlocked: boolean;
  previewMode: boolean;
  busy: boolean;
  selecting: boolean;
  isSelected: boolean;
  isCopied: boolean;
  isActive: boolean;
  isDropTarget: boolean;
  onToggleSelect: (id: string, checked: boolean) => void;
  onCopy: (token: TokenView) => void;
  onTogglePin: (token: TokenView) => void;
  onEdit: (token: TokenView) => void;
  onLogin: (token: TokenView) => void;
  onUnlockFromPreview: () => void;
  onNextHotp: (id: string) => void;
  onDragStart: (id: string) => void;
  onDragEnter: (id: string) => void;
  onDrop: (targetId: string) => void;
  onDragEnd: () => void;
}

/** 独立令牌卡片组件，通过 React.memo 隔离每秒轮询重渲染，并支持整卡点击复制与一键置顶。 */
export const TokenCard = memo(function TokenCard({
  token,
  unlocked,
  previewMode,
  busy,
  selecting,
  isSelected,
  isCopied,
  isActive,
  isDropTarget,
  onToggleSelect,
  onCopy,
  onTogglePin,
  onEdit,
  onLogin,
  onUnlockFromPreview,
  onNextHotp,
  onDragStart,
  onDragEnter,
  onDrop,
  onDragEnd,
}: TokenCardProps) {
  const canCopy = !selecting && !token.hotpReadOnly && !!token.code;
  const subtitle =
    token.accountName && !token.name.includes(token.accountName)
      ? token.accountName
      : token.kind !== "steam" &&
          token.issuer &&
          !token.name.toLowerCase().includes(token.issuer.toLowerCase())
        ? token.issuer
        : null;

  return (
    <article
      data-token-id={token.id}
      className={`token-card${isSelected ? " token-selected" : ""}${isCopied ? " token-copied" : ""}${isActive ? " token-active" : ""}${isDropTarget ? " token-drop-target" : ""}${canCopy ? " token-clickable" : ""}`}
      draggable={unlocked && !busy && !selecting}
      onClick={(e) => {
        if (!canCopy) return;
        const target = e.target as HTMLElement | null;
        if (target?.closest("button, a, input, label, select")) return;
        onCopy(token);
      }}
      onDragStart={(e) => {
        onDragStart(token.id);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", token.id);
      }}
      onDragOver={(e) => {
        if (unlocked && !busy && !selecting) {
          e.preventDefault();
          onDragEnter(token.id);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop(token.id);
      }}
      onDragEnd={onDragEnd}
    >
      {selecting && (
        <label className="token-selection">
          <input
            type="checkbox"
            aria-label={translate("选择 {{name}}", { name: token.name })}
            disabled={busy}
            checked={isSelected}
            onChange={(e) => onToggleSelect(token.id, e.target.checked)}
          />
          <span>{translate("选择")}</span>
        </label>
      )}
      <div className="token-card-top">
        <TokenAvatar token={token} />
        <div className="token-identity">
          <h3>
            {token.pinned && <Pin size={12} aria-label={translate("已置顶")} />}
            <span className="token-name-text">{token.name}</span>
          </h3>
          {token.group && (
            <small className="token-group-label">{token.group}</small>
          )}
          {subtitle && <span>{subtitle}</span>}
        </div>
        <div className="token-card-actions">
          {unlocked && !selecting && (
            <button
              type="button"
              className={`icon-button token-pin${token.pinned ? " pinned" : ""}`}
              aria-label={token.pinned ? translate("取消置顶") : translate("置顶")}
              aria-pressed={!!token.pinned}
              title={token.pinned ? translate("取消置顶") : translate("置顶")}
              disabled={busy}
              onClick={() => onTogglePin(token)}
            >
              <Pin size={15} />
            </button>
          )}
          <button
            type="button"
            className="icon-button token-menu"
            aria-label={translate("管理 {{name}}", { name: token.name })}
            disabled={!unlocked}
            onClick={() => onEdit(token)}
          >
            <Ellipsis size={19} />
          </button>
        </div>
      </div>
      <div className="code-area">
        <button
          type="button"
          className={`token-code ${token.remaining <= 5 && token.kind !== "hotp" ? "expiring" : ""}`}
          onClick={() => onCopy(token)}
          disabled={token.hotpReadOnly}
          aria-label={translate("复制 {{name}} 验证码", { name: token.name })}
        >
          {token.hotpReadOnly ? (
            translate("仅主设备")
          ) : token.code ? (
            <OtpCode code={token.code} />
          ) : (
            "•••••"
          )}
        </button>
        <button
          type="button"
          className={`copy-button ${isCopied ? "copied" : ""}`}
          aria-label={translate("复制验证码")}
          disabled={token.hotpReadOnly}
          onClick={() => onCopy(token)}
        >
          {isCopied ? <Check size={17} /> : <Copy size={17} />}
        </button>
      </div>
      {token.kind !== "hotp" && (
        <OtpProgress
          className="token-progress"
          label={translate("剩余 {{remaining}} 秒", {
            remaining: token.remaining,
          })}
          remaining={token.remaining}
          period={token.period}
          code={token.code}
        />
      )}
      <div className="token-card-bottom">
        {token.kind === "hotp" && (
          <span className="token-time">
            {translate("计数 {{value1}}", { value1: token.counter ?? 0 })}
          </span>
        )}
        {token.kind === "steam" ? (
          <button
            type="button"
            className={`session-link ${token.loggedIn ? "connected" : ""}`}
            onClick={() =>
              unlocked ? onLogin(token) : onUnlockFromPreview()
            }
          >
            {previewMode ? (
              <>
                <LockKeyhole size={14} />
                {translate("解锁后连接")}
              </>
            ) : token.enrollmentPending ? (
              <>
                <Clock3 size={12} />
                {translate("继续激活")}
              </>
            ) : token.loggedIn ? (
              <>
                <span className="status-dot" />
                {translate("已登录")}
              </>
            ) : (
              <>
                <LogIn size={12} />
                {translate("连接 Steam")}
              </>
            )}
          </button>
        ) : token.kind === "hotp" ? (
          <button
            type="button"
            className="session-link"
            disabled={!unlocked || token.hotpReadOnly}
            onClick={() => onNextHotp(token.id)}
          >
            {translate("下一验证码")}
            <ArrowRight size={12} />
          </button>
        ) : null}
      </div>
    </article>
  );
});
