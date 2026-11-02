/** The same orbit/check geometry as assets/brand/mark.svg, in a compact UI viewbox. */
export function AppMark({ size = 26 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="200 200 624 624" fill="none" aria-hidden="true">
    <path d="M598 292a236 236 0 1 0 142 247" stroke="currentColor" strokeWidth="76" strokeLinecap="round" />
    <path d="m402 504 77 78 147-158" stroke="currentColor" strokeWidth="68" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="724" cy="352" r="47" fill="currentColor" />
  </svg>;
}
