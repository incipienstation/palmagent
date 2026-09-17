// Viewport-height fix for the installed (standalone) PWA.
//
// On iOS an installed PWA can, after a *reload*, resolve `100dvh`/`100vh` LARGER
// than the on-screen viewport for a beat. The app shell is an `h-dvh` flex column
// whose bottom controls can be pushed below the fold. Because index.css locks
// document scrolling, users cannot scroll those controls back into view.
//
// `window.innerHeight` reports the actual layout-viewport height, so we mirror it
// into `--app-height` and the shells use `var(--app-height, 100dvh)`: the JS value
// when present (correct on iOS), the `dvh` fallback before this runs / if JS is
// off. `interactive-widget=resizes-content` (index.html) shrinks innerHeight with
// the on-screen keyboard, so reading innerHeight keeps the keyboard-tracking
// behavior `dvh` gave us.

let raf = 0;

function apply() {
  // Safari keeps the layout viewport tall when the keyboard opens. Use the
  // visible height at normal zoom so the in-flow composer sits above it. Ignore
  // pinch zoom: shrinking/reflowing the app while magnifying is disruptive.
  const viewport = window.visualViewport;
  const height = viewport && viewport.scale === 1 ? Math.min(window.innerHeight, viewport.height) : window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${height}px`);
  const keyboardInset = viewport && viewport.scale === 1 ? Math.max(0, window.innerHeight - height - viewport.offsetTop) : 0;
  document.documentElement.style.setProperty("--keyboard-inset", `${keyboardInset}px`);
}

// iOS can report a stale innerHeight on the first tick after a reload/orientation
// change, settling by the next paint — so re-measure on the next frame too.
function schedule() {
  apply();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(apply);
}

export function initViewportHeight(): void {
  schedule();
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);
  // bfcache restore (back/forward) re-shows the page without re-running modules.
  window.addEventListener("pageshow", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("scroll", schedule);
}
