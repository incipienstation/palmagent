// Temporarily release browser streams while the waiting service worker activates.
// This only disconnects readers; no agent lifecycle endpoint is involved.
let paused = false;
const listeners = new Set<(paused: boolean) => void>();
export const streamsPaused = () => paused;
export function pauseStreams(value: boolean) {
  if (paused === value) return;
  paused = value;
  listeners.forEach((listener) => listener(value));
}
export function onStreamPause(listener: (paused: boolean) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
