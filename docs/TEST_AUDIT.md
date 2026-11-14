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

## Follow-up: implementation-shaped assertions

A focused follow-up removes three constraints without changing product code:

- The final-evolution test visits every catalog entry and checks chest-only
  evolution; it no longer pins the catalog to exactly five entries.
- Navigation ownership still checks overlapping claims, repeated cleanup,
  blocked/unblocked notifications and unsubscribe. It no longer requires a
  notification for each claim change while the blocked state stays the same.
- The shared API read test retains concurrent and subsequent fresh reads plus
  `no-store`. The model-catalog wrapper's duplicate cache/call-count test and
  the redundant final repository-read count are removed.

This removes one Playwright case from the preceding audit's 674-case baseline.
Permission mappings, queue ordering, expiry boundaries and stale-response
protection remain unchanged. No runtime improvement is claimed.

## Broader follow-up: reduce browser scenario duplication

At base `2a1246fd`, Playwright collects 683 cases. This pass reduces that to 585
(98 removed, 14.3%) across 36 spec files. The earlier 674-case inventory is a
historical snapshot, not the baseline for this change.

| Area | Removed | Representative coverage retained |
| --- | ---: | --- |
| Image and Mermaid viewers | 16 | Local image smoke in static, streaming and long Markdown; generated-link and sandbox scheme cases; unsafe sources; image zoom/pan/touch; diagram wheel modifiers, keyboard access and desktop fullscreen; session cache invalidation |
| Game browser scenarios | 11 | One sprite load-failure/retry path, one chest-evolution UI path, game movement/pause/save, final-reply and scoped-attention return, campaign settlement, failed storage and legacy migration; all 32 engine tests |
| History and Trace | 10 | Mobile touch and desktop wheel reading, prepend anchors, late image measurement, pagination races, failed/offline loading, one continuous-prefetch viewport; pure transcript classification tests |
| Composer, placeholder and voice | 12 | Shared composer interactions, both keyboard-resize models with a nonempty draft, narrow overflow, forced colors, IME and shortcuts, microphone lifecycle and one attachment draft during recording |
| Spaces, inbox and pins | 12 | Narrow/desktop navigation and responsive transitions, search/filter state, one pin synchronization/reorder viewport, both keyboard-resize models with a real query |
| Browser/installed navigation matrix | 5 | Browser layer/history flows plus dedicated installed root-exit and native Back/CDP regressions |
| Remaining UI flows | 32 | Existing interaction tests replace duplicate header, Markdown, status display, toast, sheet and loading-theme checks; mobile cases represent width-independent persistence, migration and delivery behavior |

The tradeoff is intentional: the suite no longer tests every width/theme/input
combination or every consumer of a shared visual component. CSS/layout-specific
regressions outside the retained representatives may no longer be caught. This
is not a claim that every removed case had an identical replacement. In
particular, game balance/relay rules stay at the engine layer, shared zoom/pan
behavior is exercised through images, and Mermaid keeps its rendering and
navigation integration checks. The partial-answer browser case retains draft,
disclosure and answer visibility checks; chronological ordering stays in the
transcript-model tests and scroll anchoring in the history suites, avoiding
one-shot coordinates of rows that virtualization can temporarily unmount.

For example, six sprite-failure browser scenarios previously repeated the same
retry and attention flow. They now exercise one asset. Scheme variants no longer
multiply the image smoke matrix, and diagrams no longer repeat the shared image
viewer's pan/pinch tests. The installed/browser matrix is retained only where
installation mode changes behavior.

The removed cases account for 232.6 seconds of summed passing-test durations in
CI run `43554946852`, attempt 2 (683 cases, 1320.3 summed seconds). This is 17.6%
of that run's summed browser test time, not a wall-clock speedup: four shards run
in parallel, setup/build time remains, and test distribution and runner load can
change. Extra inner theme loops are also removed but are not counted in those
232.6 seconds. The figures exclude the failed first attempt and its retry delay.

Server CI has a separate bottleneck. Run `43557837425` spent 248 seconds in its
contracts/runtime step, including native builds and process tests. Slow retained
cases exercise delayed startup, native routine recovery, provider continuity and
large durable uploads. This browser-only change does not shorten that lane or
change which CI checks run. Security, persistence and release gates remain.
