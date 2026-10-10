# Dependency patches

## React Virtuoso 4.18.13

The transcript uses Virtuoso's ESM browser entry. Its prepend compensation normally skips
height changes when both rendered ranges begin at index zero. With row overscan and a few tall
answers, index zero can remain mounted while the reader is far below it. If the estimated
prepend height exceeds the measured page, shrinking the scroll range clamps the viewport and
loses the reader's movement.

The patch computes compensation from the offset of the row at the reading position, using
Virtuoso's measured layout. Total-height changes below that row no longer move the viewport.
It retains that row's stable index through the first measurement after a prepend, including
at the unloaded top where the header would otherwise select a newly inserted row. The size
observer releases the retained index after publishing its measurement, even if sizes match.
It retains native-clamp compensation and uses the upstream total-height fallback when the
rendered ranges do not share that row. Measurements still correct the position after the
reader pauses or changes direction; they no longer depend on the transient direction flag.
The existing guards for count changes, recalculation, and programmatic scrolling remain.
The application no longer restores a separate top-edge scroll target. Virtuoso owns the
prepend correction without a timed correction window. The application also preserves fractional
row heights so per-row rounding cannot accumulate drift across a page.
Only the ESM entry used by the web build is patched; the CommonJS entry is unused by Palmagent.

When upgrading Virtuoso, review `upwardScrollFixSystem` and remove or rebase the patch. Run
`history-prepend-reading.spec.ts` against a production web build, together with the history,
scroll, and loading suites. The regressions measure continuous row movement, final reading
distance, and an intentionally delayed size measurement. A large jump must not pass merely
because its old anchor left the viewport.
