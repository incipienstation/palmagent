# Test selection

Tests spend CI time and constrain future changes. Add one only when it protects a concrete,
consequential failure that existing checks do not adequately catch. Passing more cases is not
itself evidence of better coverage.

## Before writing

- Name the failure, its observable consequence, and the existing test nearest to it. Extend that
  test when the same setup and behavior suffice; do not create a test for every changed function.
- Prefer no new test for copy, decoration, static declarations, trivial forwarding, or reversible
  low-impact UI changes. Use typechecking, the existing suite, or a focused manual inspection.
- Use the cheapest layer that can reproduce the failure. Test policy, parsing, state transitions,
  and game rules below the browser. Keep browser tests for browser-owned behavior and meaningful
  integration: native input/IME, focus, scrolling, permissions, rendering, and user workflows.
- Keep distinct auth, data-loss, uncertain-delivery, persistence, recovery, and release boundaries.
  Short code can encode important policy; expensive tests are not automatically redundant.

## Keep the suite small

- Cover shared behavior once, plus consumer integration only where its wiring can fail differently.
  Do not repeat a dialog, toast, picker, viewer, or API wrapper contract on every screen.
- Start with one representative viewport, theme, asset, and data example. Add a variant only for a
  distinct branch or failure mechanism; avoid Cartesian products. Use narrow and desktop coverage
  where layout actually changes, not for width-independent persistence or request ordering.
- Assert user outcomes or stable external contracts. Avoid copying constants/catalogues into
  expectations, exact decorative pixels/classes, animation choreography, private state, or incidental
  call counts. Counts and order belong in tests when they prove deduplication, bounded work, or a
  protocol requirement. Keep source checks only for an explicit trust or architecture boundary.
- Use controlled clocks, deferred responses, and event gates instead of real sleeps. Keep real
  process/timer coverage only where simulation would miss the failure; justify the wait or large
  fixture and use the smallest representative case. Crossing an obsolete timeout is not a standing
  reason to sleep on every CI run.
- Do not replace removed cases with `.skip`, retries, weaker assertions, or giant unrelated flows
  to improve counts. Remove obsolete helpers and fixtures. Combine cases only when one coherent
  scenario naturally exercises the same behavior, such as failure followed by successful retry.

## Review and evidence

In the PR's verification notes, briefly identify the distinct risks covered, existing coverage
reused, and any intentional reduction. New browser matrices, long real waits, and large fixtures
need an explicit reason. No new test is a valid outcome; no coverage-percentage or test-count target
is required. For suite reductions, compare collected cases and report measured runtime separately:
summed test duration, CI job duration, and workflow wall time are different quantities.
