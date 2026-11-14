# Test coverage audit — November 2026

The audit inventories 188 test-bearing files at commit `dbef80c`: 62 server,
83 browser, six browser-game, six Rust, and 31 tooling test files. It also checks
the PWA state and web-harness scripts and the smoke/verification entry points.
The inventory covers test declarations, parameterized variants, assertion patterns,
fixtures and execution paths; removal candidates receive a body-level comparison
against retained coverage. This is a redundancy audit, not a mutation-testing
proof that every retained assertion is necessary.

## Decisions

| Area | Removed or simplified | Retained coverage |
| --- | --- | --- |
| Screen snapshots | 15 whole-screen screenshot assertions; 16 obsolete PNG files | Image loading/enlargement, question answers, queue interactions, handoff, rename, settings, disclosure and update behavior |
| Snapshot fixture | Moved one baseline PNG into `tests/assets/tall-history.png` without changing its bytes | Delayed tall-image history and reading-position regression |
| One-off review campaign | Eight opt-in capture-only cases in `agent-ui-review.spec.ts` | General `VISUAL_REVIEW_DIR` captures and failure artifacts |
| Retired browser output mode | Duplicate compact/verbose variants in working, checkpoint and output-access tests; redundant history-prepend case; ignored preference setup | Both saved-preference compatibility cases in `trace.spec.ts`; shared/server compact/full projection contracts |
| Brand and settings | Exact focus-border color and label font/color/panel equality cases | Contrast, selected theme, browser metadata, installed assets, settings navigation and persistence |
| Header and dialogs | Gradient, backdrop, exact action width, CSS class and action-pair alignment assertions | Accessible heading, minimum touch targets, reachable actions, focus restoration, responsive dialogs and viewport constraints |
| Composer | Exact decorative dimensions, toolbar spacing/order and sampled animation choreography; repeated middle-width and theme-independent geometry variants | Narrow/desktop interaction, drafts, focus, keyboard resize, scrolling, scrollbar stability and reduced motion |
| Placeholder | Exact 75 ms fade timing and intermediate pseudo-element opacity | Delivery-state hints, input identity, focus, selection, draft and layout continuity, reduced motion |
| Working, Stop and scroll control | Exact shimmer name, decorative Stop size, scroll-control opacity token/backdrop and fade duration | Working lifecycle, immediate Stop, touch targets, reading/draft preservation, input-aware visibility and reduced motion |
| Voice feedback | Duplicate desktop waveform run and exact leftward bar-travel assertions | Volume response, stop/reset/cancel, microphone lifecycle, responsive recording controls and reduced motion |

Whole-screen baselines were design captures rather than focused rendering
regressions that needed pixel comparison. This intentionally stops enforcing their
exact appearance; the remaining interaction and accessibility checks do not claim
pixel equivalence. Future focused visual regressions can still use the existing
snapshot tooling under the web README's QA policy.

Playwright collection falls from 696 to 674 cases (22 removed, including eight
opt-in review captures). Collection succeeds without errors. This count is not
a measurement of runtime or of assertions removed from retained cases.

## Areas retained after review

- **Server contracts and integration:** adapter protocol, message delivery,
  ambiguous outcomes, persistence/migrations, authentication, path containment,
  attachment quotas/retention, process ownership, recovery, routines, terminals,
  updates and read freshness. Similar routes exercise different failure boundaries;
  unit and real process/HTTP tests are not interchangeable coverage. The added
  message-policy and injected-clock tests cover FIFO lease boundaries, uncertain
  delivery, failed persistence, and shutdown without introducing real-time waits.
- **Rust:** workspace boundaries, calendar calculations, routine scheduling,
  recovery and daemon lifecycle. The 41-second startup regression crosses the old
  real startup deadline; deleting it for its duration would remove a distinct
  regression check. Its runtime remains an optimization candidate, not evidence
  of unnecessary coverage.
- **Tooling and release:** scope selection, verification orchestration, packaging,
  installation, signed channels, immutable release metadata, compatibility,
  continuity, repository skills and leak checks. Source assertions that enforce
  trust or architecture boundaries are retained.
- **PWA, harness and game:** offline/update behavior, isolated test servers,
  worker state, deterministic game rules and real browser interaction remain.
- **Other browser tests:** navigation, IME/native input, drafts, accessibility,
  streaming, reading position, error recovery, permissions, caching and media.
  Viewport, input and theme variants remain where they cover distinct behavior.

No production behavior, CI lane, security boundary or server test is changed.
The browser case count and retained behavior can be checked with Playwright
collection and the scoped verifier. This audit does not establish a CI speedup;
in particular, it does not shorten the server verification lane.
