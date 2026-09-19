# @palmagent/web

Mobile-first, **installable** PWA that drives the Palmagent backend over
**SSE (read) + REST (control)**. React + Vite + TypeScript, service worker via
`vite-plugin-pwa` (Workbox). The event log renders normalized `AgentEvent` records. Account-limit views
follow each provider's quota structure.

## UI stack (shadcn-style)

Tailwind CSS v4 (`@tailwindcss/vite`, tokens in `src/index.css`) with
**vendored shadcn/ui components** in `src/components/ui/` (Radix primitives +
`cva`/`tailwind-merge`, `cn()` in `src/lib/utils.ts`, `@/*` path alias,
`components.json` for the shadcn CLI). The bottom-sheet repo picker is a `vaul`
drawer; transient feedback uses Sonner, and icons are `lucide-react`. Components
are sized mobile-first (44px tap targets); add new ones with `pnpm dlx shadcn@latest add <name>` or by hand in
the same style. Gotcha to keep: Radix `Select` inside a `<form>` echoes a stale
`""` through `onValueChange` when value + items land in the same render — keep
the `v && set…(v)` guards.

## Run

```bash
# 1. backend (separate terminal) — serves /api on :4000
pnpm dev                                  # = nx run @palmagent/server:dev

# 2. this app — dev server on :4200, proxies /api -> :4000
pnpm --filter @palmagent/web dev

# checks / production build
pnpm typecheck                            # whole workspace, incl. this project
pnpm --filter @palmagent/web build # emits dist/ + service worker + manifest
pnpm --filter @palmagent/web preview
```

The default proxy target is the internal loopback server. Point it at another
environment with an HTTPS URL such as `API_PROXY=https://api.example.invalid`;
plaintext proxy targets are accepted only on loopback.

## QA harness (Playwright)

A **headless, isolated** E2E harness. It builds the app and runs it against a
**hermetic mock backend** (`tests/mock-server.mjs` serves `dist/` + answers
`/api` over the real SSE+REST wire contract from `tests/fixtures.mjs`) — no real
dispatcher, no `claude`/`codex` CLI — on a **Galaxy S25 mobile viewport**. It exists
to stop the recurring mobile-layout regressions (Radix ScrollArea horizontal
overflow, the `100dvh` viewport scroll-lock, FAB/`--banner-h` overlap) from
shipping again.

```bash
# one-time: fetch the browser
pnpm --filter @palmagent/web exec playwright install chromium

pnpm --filter @palmagent/web test:e2e          # build + run (the gate)
pnpm --filter @palmagent/web test:e2e:update   # refresh visual baselines
```

- Tests in `tests/e2e/*.spec.ts` protect observable contracts: drafts survive
  navigation, keyboard focus returns, controls remain reachable, content fits
  the viewport, and overlays do not cover input. Assert those outcomes instead
  of incidental copy, exact styling dimensions, or internal component structure.
  Keep exact values when they define a contract, such as a minimum touch target
  or text contrast; read brand expectations from the shared palette.
- Run shared behavior once. Add viewport, theme, or input variants only when
  they exercise a distinct failure mode. Remove duplicate flows and tests that
  merely recheck the test framework.
- Use **visual snapshots** (`toHaveScreenshot`) only for a specific rendering
  regression that behavioral assertions cannot adequately capture. Prefer a
  focused region to a whole-screen baseline. Retained baselines live in
  `tests/e2e/*-snapshots/`; regenerate only for intentional changes and inspect
  the diff. A screenshot of the current design is not itself a stable contract.
- The repository's `pnpm verify` gate runs this suite and the service-worker
  update smoke before a PWA change can be delivered.
- Read-only tests share a mock server and use up to two workers. Rename tests run
  sequentially on a separate server, so their requests and cleanup cannot change
  other tests' fixtures. Add any other suites that mutate backend fixtures to
  `statefulSpecs` in `playwright.config.ts`. The servers use `E2E_PORT` (default
  `4317`) and the following port; the global worker limit is two. Project assignment
  does not change snapshot paths.
- Baselines are generated on Linux (`*-linux.png`); regenerate on the same OS the
  gate runs on (this host / CI).

## Features

Open the navigation menu for Tasks, Spaces, Routines, Usage, recent tasks, and
Settings. New task stays available at the bottom of the drawer and task list.
Focused screens retain Back; the task title opens session details.

1. **Dispatch** (`#/new`) — pick/register a repo and type in the bottom composer.
   Focusing it reveals the model/effort summary; tap it to configure the agent,
   model, effort, permission, worktree isolation, and optional title. The + menu
   offers Camera and Photos. Send creates the task via `POST /api/tasks`.
2. **Inbox** (`#/`) — ONE `GET /api/stream`; every task rendered live from the
   `tasks` snapshot frames, grouped by status. Use a row's **⋮ → Rename** to
   change its session name without opening it. Use **Spaces** to filter by a single
   project, folder, or worktree, or choose **All spaces**. The mobile sheet and
   desktop sidebar search names and full paths; worktrees expand separately and
   appear automatically in search results. The selected filter survives reloads.
3. **Task detail + steer** (`#/task/:id`) — scoped `GET /api/stream?task=:id`;
   virtualized event log (assistant token deltas coalesced, tool calls/results, result)
   with a single Send button (hold, right-click, or press Arrow Down for the Send/Queue toggle),
   an editable persistent queue,
   stop (interrupt the turn, task stays resumable), cancel, and archive. Tap the
   header title for session configuration, pull requests, and shell handoff;
   the task status and local-control notices remain visible in the conversation.
4. **Account limits** — session footers show remaining account allowance and reset
   countdowns in aligned columns, including while idle or previewing a local session. When available,
   Claude shows 5-hour, weekly, and model-specific windows; Codex keeps its named quota buckets
   and reported window lengths. Details show additional windows and available
   credits/extra usage. These are shared account limits, not session token totals.
   Reads are cached per provider home for five minutes. Missing data stays unknown;
   a passed reset time waits for a new report instead of assuming a full allowance.
   The server asks the installed CLI for account limits without starting a model
   turn or reading credentials itself. Claude's `get_usage` control request is
   experimental; unsupported CLI responses and failed reads show an unavailable
   state. Codex uses the app-server `account/rateLimits/read` request.

The detail header's **⋮ → Rename** opens the same editor. Names are saved in
Palmagent and synchronized across connected screens, including for running and
local sessions. Renaming keeps the original prompt, native CLI session, and activity
order intact.

## Output detail

Agent replies render Markdown images with relative file paths or URLs such as
`![Preview](https://example.invalid/preview.png)`. Tap an image or embedded tool
image to open a larger view; choose **Actual size** to pan across its full resolution.
An image wrapped in a Markdown link keeps that link.
Relative paths resolve from the task's working directory; absolute paths and local
`file:` URLs work only inside that directory, including after resolving symlinks.
Local previews support PNG, JPEG, GIF, and WebP up to 5 MB. SVG and files outside
the working directory are not served. Keep generated previews in the task directory
to display them. The file must still exist when viewed; previews are not archived
or cached for offline use. Missing or unsupported images display their description.

Settings groups device preferences separately from installation settings. Appearance and
output detail change directly in the overview; Spaces and Updates open their own screens.
Back returns to the overview without losing a folder draft.

Settings → Output detail controls the session transcript:

- **Compact** collects background work per turn and previews only the latest known progress
  while running. Configuration is available in Session details.
- **Default** groups adjacent activity and keeps a two-line progress preview.
- **Verbose** shows all recorded events.

Account allowance and reset countdowns stay visible in every mode. Account Details shows
the additional provider-specific quota windows.

Activity expands to the full recorded output. In Compact and Default, individual tool failures
stay inside Activity with a failure count in its summary. Run errors have one expandable
notice per run; earlier errors use neutral styling after a follow-up or a successful terminal
result. This preserves the diagnostic record without claiming that every cause was resolved.
Questions, approval requests, final answers, and images stay visible. Older messages and
providers without explicit progress/final metadata retain their prose; the client does not
guess which text is safe to fold.

## How it talks to the backend

- **Contracts come from `@palmagent/shared`** (`AgentEvent`, `TaskState`,
  `Permission`, `Repo`, REST DTOs, `SseFrame`, and shared branding). Nothing is
  redefined. Type-only imports are erased by esbuild; shared intentionally uses
  source exports, so it needs no separate build step here.
- **`EventSource`, not fetch streaming.** On reconnect the browser resends
  `Last-Event-ID`; the server replays everything after it. The scoped stream
  additionally gates on the per-task `seq` (carried on the SSE `id:` line) so a
  replayed event is never rendered twice — no gaps, no dupes.
- **History and rendering:** the scoped stream requests a recent page with `tail=1`.
  Its initial snapshot identifies the replay boundary and older-history cursor;
  `GET /api/tasks/:id/history?before=:seq` loads earlier pages without changing the
  live cursor. Pages target 200 events and include whole assistant messages so
  Markdown is never split at a page boundary. React Virtuoso renders nearby rows
  in the Radix scroll area;
  row expansion survives scrolling out of view, and live events publish once per
  animation frame. Active and long Markdown messages parse in a worker and reuse unchanged
  rendered blocks; worker failures retain readable plain text. Task snapshots reuse
  unchanged rows, and the inbox retains its search and reading position across navigation.
  The inbox requests `snapshots=1` to omit unused event bodies.
- **Client caching:** repositories and routines reuse successful reads in memory for
  30 seconds; usage and routine runs for 10 seconds. Concurrent reads share a
  request. Mutations invalidate before and after the request, including failed
  requests with uncertain outcomes; other tabs receive invalidation signals.
  Foreground and online transitions expire REST reads and refresh mounted views. Task snapshots invalidate
  usage and run history. Authentication, settings, discovery, filesystem checks,
  live task state, and account limits always reach the network.
- **Conversation navigation:** the last five visited transcripts are retained in
  memory for up to five minutes, within a 4 MB serialized-size budget. Returning
  shows the retained messages and resumes SSE after the last received sequence,
  preserving loaded older pages. Oversized transcripts reload the recent tail.
  Authentication changes clear response and transcript caches.
- **Service worker:** only the app shell is precached, with an offline navigation
  fallback. API responses are never persisted or served as offline successes;
  an offline first load cannot authenticate. Upgrading removes the legacy API
  cache. HTTP API responses use `no-store`; fingerprinted assets remain immutable.

## Cache policy coverage

| Surface | Policy |
| --- | --- |
| Hashed JS, CSS, Markdown worker, icons | Workbox precache; hashed HTTP assets immutable |
| HTML, service worker, manifest | HTTP revalidation; worker update bypasses HTTP cache |
| Auth, push enrollment, task controls, settings | Network; API HTTP responses use no-store |
| Task list and active transcript | SSE snapshots and sequence-based replay; no service-worker interception |
| Earlier history pages | Retained with the bounded transcript; failed or aborted loads are retried |
| Repositories, routines, usage, run history | Short memory reuse and concurrent request deduplication |
| Discovery, path validation, filesystem browse | Network so external settings and filesystem changes remain authoritative |
| Account limits | Network in the client; provider-scoped server cache owns freshness |
| Markdown rendering | Existing bounded content-keyed worker cache |
| Theme, output mode, form drafts, selected space | Local preferences, not server response caches |
| Update checkpoints | Existing per-tab IndexedDB handoff, consumed after reload |
| Reading position | Existing bounded page-local navigation state |

## Brand palette

`src/brand.json` owns the Palm Teal palette for light and dark mode. Change its
semantic color pairs to replace the brand: `primary` / `primary-foreground` for
filled actions, `primary-active` for pressed actions, `accent` / `accent-foreground`
for selection and hover, and `chrome` for browser and installed-app chrome.
Vite injects these as `--brand-*` variables before first paint; `src/index.css`
maps them to the UI's semantic tokens. Theme changes and the PWA manifest read
that same palette. Keep neutral surfaces and status colors independent.

After editing the palette or `src/assets/palm.svg`, run
`pnpm --filter @palmagent/web icons:generate` to refresh the favicon, adaptive
logo, and PNG app icons. Review both themes, run `pnpm web:verify`, and update
intentional screenshot changes. Components use semantic utilities such as
`bg-primary`, `text-primary`, and the Button `selected` variant; do not embed
brand hex values or color-family utility classes in components.

## Icons

`public/icon-*.png`, `apple-touch-icon.png`, and `favicon.svg` are reviewed
Palmagent source assets. Keep the maskable icon's glyph inside the adaptive-icon
safe zone.

`public/notification-badge.png` is the separate 96×96 notification status-bar
asset: white logo strokes on a transparent background. Android masks its alpha
channel, so never use a filled app icon as the notification `badge`. The notification
body continues to use the color app icon. Both assets are precached by the service worker.

After changing the logo geometry and regenerating app icons, regenerate the badge from its foreground
geometry with `node apps/web/scripts/generate-notification-badge.mjs` from the repository
root (requires the Playwright Chromium installation above). Review the image and run
`pnpm web:verify`. The notification test checks the built asset's silhouette, offline
availability, and real service-worker push options; Android status-bar rendering still
needs a device check with a new notification after the updated worker activates.

## Message controls

The composer stays compact until focused or holding a draft. Text and image
previews expand above the action row, with long drafts scrolling inside the input.
Model and effort open Configure for idle Send and queued messages; an active Send
uses the running turn's settings. Camera and Photos use the existing image limits.

Tap Send to deliver the draft to the current run, or start a run when idle.
Hold Send to open the Send/Queue toggle. Selecting a mode does not submit; tap
again to send. Queue applies to the current draft and resets after submission.
Hold a queued message for Edit prompt, Send now, and Remove from queue. Editing
uses the composer while preserving the ordinary text and attachment draft.
The editor renews a server hold; after a disconnected editor's hold expires,
the saved prompt can run and stale edits cannot overwrite it.

Long press opens controls after 450 ms; scrolling and pointer cancellation
cancel it. Right-click and Arrow Down expose the same actions. Supported
browsers vibrate briefly when a menu opens or the delivery mode changes;
visual feedback remains available when vibration is unavailable.

See [message delivery and recovery](../../docs/MESSAGES.md) for server behavior.

## Transient feedback

Toasts are neutral, text-sized pills centered above the composer or bottom actions.
A new message replaces the previous one. Brief confirmations disappear after
2.5 seconds, errors after 6 seconds, and the exit hint retains its 2-second window.
Longer messages wrap within the viewport. Swipe down to dismiss, or focus the
notification with Alt+T and press Escape. Toasts follow the available keyboard space
and respect reduced-motion preferences.
