# Dependency patches

## React Virtuoso 4.18.13

The transcript uses Virtuoso's ESM browser entry. Its prepend compensation normally skips
height changes when both rendered ranges begin at index zero. With row overscan and a few tall
answers, index zero can remain mounted while the reader is far below it. If the estimated
prepend height exceeds the measured page, shrinking the scroll range clamps the viewport and
loses the reader's movement.

The patch lets Virtuoso apply its existing height and native-clamp compensation for the first
measurement of a prepend while reading away from the bottom. The exception ends after that
measurement or the following frame, so ordinary disclosure and live-row resizing retain the
upstream behavior. It does not add a second scroll-position owner to the application. Only the
ESM entry used by the web build is patched; the CommonJS entry is unused by Palmagent.

When upgrading Virtuoso, review `upwardScrollFixSystem` and remove or rebase the patch. Run
`history-prepend-reading.spec.ts` against a production web build, together with the history,
scroll, and loading suites. The regression measures both continuous row movement and the final
reading distance; a large jump must not pass merely because its old anchor left the viewport.
