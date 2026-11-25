import { memo } from "react";

/** 对纯数字 6 位 / 8 位验证码按视觉分组显示，同时保持 DOM 文本无空格，便于朗读、复制与断言。 */
export const OtpCode = memo(function OtpCode({ code }: { code: string }) {
  if (/^\d{6}$/.test(code)) {
    return (
      <>
        <span>{code.slice(0, 3)}</span>
        <span className="otp-chunk">{code.slice(3)}</span>
      </>
    );
  }
  if (/^\d{8}$/.test(code)) {
    return (
      <>
        <span>{code.slice(0, 4)}</span>
        <span className="otp-chunk">{code.slice(4)}</span>
      </>
    );
  }
  return <>{code}</>;
});
