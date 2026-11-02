import { useLayoutEffect, useRef } from "react";
import "./otp-progress.css";

type Sample = { remaining: number; period: number; code: string };
type Anchor = Sample & { duration: number; monotonic: number; wall: number };
const seconds = (value: number, period: number) => Math.max(0, Math.min(period, Number.isFinite(value) ? value : 0));
const periodSeconds = (value: number) => Number.isFinite(value) && value > 0 ? value : 30;

/** Native code polling stays once a second; only the compositor animates between samples. */
export function OtpProgress({ remaining, period, code, className, label }: Sample & { className: string; label?: string }) {
  const fill = useRef<HTMLSpanElement>(null);
  const controller = useRef<{ sample: (value: Sample) => void } | null>(null);
  useLayoutEffect(() => {
    const bar = fill.current;
    if (!bar) return;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let anchor: Anchor | null = null;
    let animation: Animation | null = null;
    let reanchor = false;
    const left = () => {
      if (!anchor) return 0;
      const monotonic = Math.max(0, performance.now() - anchor.monotonic);
      // Some WebViews pause performance.now during device sleep. Native data will
      // resync on resume; never restart an old cycle while waiting for that data.
      const wall = Date.now() - anchor.wall;
      const elapsed = wall > monotonic + 1000 ? wall : monotonic;
      return Math.max(0, anchor.duration - elapsed);
    };
    const paint = () => {
      const duration = left();
      if (animation) { animation.onfinish = null; animation.cancel(); animation = null; }
      const fraction = anchor ? duration / (anchor.period * 1000) : 0;
      bar.style.transform = `scaleX(${fraction})`;
      if (!anchor || document.hidden || motion.matches || duration <= 0 || typeof bar.animate !== "function") return;
      const next = bar.animate([{ transform: `scaleX(${fraction})` }, { transform: "scaleX(0)" }], { duration, easing: "linear", fill: "forwards" });
      animation = next;
      next.onfinish = () => {
        if (animation !== next) return;
        bar.style.transform = "scaleX(0)";
        animation = null;
        next.cancel();
      };
    };
    controller.current = {
      sample(value) {
        const period = periodSeconds(value.period);
        const remaining = seconds(value.remaining, period);
        const wall = Date.now();
        // Rust supplies whole seconds from this device's clock plus Steam's whole-
        // second offset. Preserve its phase using the local fractional second.
        const rawDuration = Math.max(0, remaining * 1000 - ((wall % 1000) + 1000) % 1000);
        const previous = left();
        const wrapped = anchor && remaining > anchor.remaining && anchor.remaining <= Math.max(1, period / 4) && remaining >= period * 0.75;
        const clockChanged = anchor && Math.abs((wall - anchor.wall) - (performance.now() - anchor.monotonic)) > 1000;
        const sameCycle = anchor && anchor.period === period && anchor.code === value.code && !wrapped && !clockChanged && !reanchor;
        // An IPC response can straddle a second boundary. Its whole-second value
        // must not make a running cycle gain time; a fresh code or explicit clock
        // correction can still establish a new deadline.
        const duration = sameCycle ? Math.min(rawDuration, previous) : rawDuration;
        reanchor = false;
        if (sameCycle && animation?.playState === "running" && Math.abs(previous - duration) < 150) {
          anchor!.remaining = remaining;
          return;
        }
        anchor = { ...value, remaining, period, duration, monotonic: performance.now(), wall };
        paint();
      },
    };
    const clockSynced = () => { reanchor = true; };
    document.addEventListener("visibilitychange", paint);
    motion.addEventListener("change", paint);
    window.addEventListener("steamguard:clock-synced", clockSynced);
    return () => {
      controller.current = null;
      document.removeEventListener("visibilitychange", paint);
      motion.removeEventListener("change", paint);
      window.removeEventListener("steamguard:clock-synced", clockSynced);
      if (animation) { animation.onfinish = null; animation.cancel(); }
      anchor = null;
    };
  }, []);
  useLayoutEffect(() => { controller.current?.sample({ remaining, period, code }); }, [remaining, period, code]);
  const safePeriod = periodSeconds(period);
  return <span className={className} data-otp-progress="" role={label ? "progressbar" : undefined} aria-label={label} aria-valuemin={label ? 0 : undefined} aria-valuemax={label ? safePeriod : undefined} aria-valuenow={label ? seconds(remaining, safePeriod) : undefined} aria-hidden={label ? undefined : true}>
    <span ref={fill} className="otp-progress-fill" style={{ transform: `scaleX(${seconds(remaining, safePeriod) / safePeriod})` }} />
  </span>;
}
