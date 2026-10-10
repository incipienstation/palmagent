# Dependency patches

## React Virtuoso 4.18.13

The transcript uses Virtuoso's ESM browser entry. Its prepend compensation normally skips
height changes when both rendered ranges begin at index zero. With row overscan and a few tall
answers, index zero can remain mounted while the reader is far below it. If the estimated
prepend height exceeds the measured page, shrinking the scroll range clamps the viewport and
loses the reader's movement.

The patch computes compensation from the offset of the row at the reading position, using
Virtuoso's measured layout. Total-height changes below that row no longer move the viewport.
It retains native-clamp compensation and uses the upstream total-height fallback when the
rendered ranges do not share that row. Measurements still correct the position after the
reader pauses or changes direction; they no longer depend on the transient direction flag.
The existing guards for count changes, recalculation, and programmatic scrolling remain.
The application does not gain a second scroll-position owner or a timed correction window.
Only the ESM entry used by the web build is patched; the CommonJS entry is unused by Palmagent.

When upgrading Virtuoso, review `upwardScrollFixSystem` and remove or rebase the patch. Run
`history-prepend-reading.spec.ts` against a production web build, together with the history,
scroll, and loading suites. The regressions measure continuous row movement, final reading
distance, and an intentionally delayed size measurement. A large jump must not pass merely
because its old anchor left the viewport.
