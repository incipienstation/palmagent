export function vibrate(pattern: number | number[]) {
  if (typeof navigator === "undefined") return;
  try { navigator.vibrate?.(pattern); } catch { /* Haptic hardware is optional. */ }
}
