// shadcn's CSS utility handles themes and reduced motion. Unsupported color
// syntax falls back to readable, static text instead of a transparent label.
export function WorkingLabel() {
  return <span role="status" className="inline-block font-sans text-base font-normal text-muted-foreground shimmer not-supports-[color:oklch(from_white_l_c_h)]:shimmer-none">Working…</span>;
}
