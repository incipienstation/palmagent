// Viewport-height fix for the installed (standalone) PWA.
//
// On iOS an installed PWA can, after a *reload*, resolve `100dvh`/`100vh` LARGER
// than the on-screen viewport for a beat. The app shell is an `h-dvh` flex column
// with the bottom TabBar as its last in-flow child, so the over-measured column
// pushes the TabBar below the fold — and because index.css locks the document
// (`overflow:hidden`), there's nothing to scroll to bring it back, so it stays
// gone until a navigation/resize recomputes the layout. (The fixed FAB is
// unaffected — it's positioned off the real viewport, which is why a refresh
// leaves the FAB but drops the tab bar.)
//
// `window.innerHeight` reports the actual layout-viewport height, so we mirror it
// into `--app-height` and the shells use `var(--app-height, 100dvh)`: the JS value
// when present (correct on iOS), the `dvh` fallback before this runs / if JS is
// off. `interactive-widget=resizes-content` (index.html) shrinks innerHeight with
// the on-screen keyboard, so reading innerHeight keeps the keyboard-tracking
// behavior `dvh` gave us.

let raf = 0;

function apply() {
  document.documentElement.style.setProperty("--app-height", `${window.innerHeight}px`);
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
}
