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
drawer; icons are `lucide-react`. Components are sized mobile-first (44px tap
targets); add new ones with `pnpm dlx shadcn@latest add <name>` or by hand in
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

- **Two kinds of check** (`tests/e2e/*.spec.ts`): explicit **layout-contract
  assertions** (no horizontal overflow, document never scrolls, FAB + content
  padding both track `--banner-h`) and **visual snapshots** (`toHaveScreenshot`).
  Baselines live in `tests/e2e/*-snapshots/` and **are committed — that image is
  the contract.** Regenerate only when a UI change is intentional, and eyeball
  the diff.
- The repository's `pnpm verify` gate runs this suite and the service-worker
  update smoke before a PWA change can be delivered.
- Baselines are generated on Linux (`*-linux.png`); regenerate on the same OS the
  gate runs on (this host / CI).

## Features

1. **Dispatch** (`#/new`) — pick/register a repo, choose agent + permission,
   send a prompt → `POST /api/tasks`.
2. **Inbox** (`#/`) — ONE `GET /api/stream`; every task rendered live from the
   `tasks` snapshot frames, grouped by status. Use a row's **⋮ → Rename** to
   change its session name without opening it.
3. **Task detail + steer** (`#/task/:id`) — scoped `GET /api/stream?task=:id`;
   virtualized event log (assistant token deltas coalesced, tool calls/results, result)
   with follow-up, steer (surfaces *injected* mid-turn vs *queued* next-turn),
   stop (interrupt the turn, task stays resumable), cancel, and archive.
4. **Account limits** — session footers show remaining account allowance and reset
   countdowns, including while idle or previewing a local session. When available,
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

Settings → Detail controls the session transcript and surrounding metadata:

- **Compact** collects background work per turn and previews only the latest known progress
  while running. Configuration is available in Session details.
- **Default** groups adjacent activity and keeps a two-line progress preview.
- **Verbose** shows all recorded events.

Account allowance and reset countdowns stay visible in every mode. Account Details shows
the additional provider-specific quota windows.

Activity expands to the full recorded output. Questions, approval requests, failures, final
answers, and images stay visible. Older messages and providers without explicit progress/final
metadata retain their prose; the client does not guess which text is safe to fold.

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
  animation frame. The inbox requests `snapshots=1` to omit unused event bodies.
- **Service worker:** app shell is precached (cache-first) with a navigation
  fallback so the shell loads offline; `/api/*` is network-first **except**
  `/api/stream`, which is `NetworkOnly` (an open event-stream must never be
  cached). See `vite.config.ts`.

## Icons

`public/icon-*.png`, `apple-touch-icon.png`, and `favicon.svg` are reviewed
Palmagent source assets. Keep the maskable icon's glyph inside the adaptive-icon
safe zone.

`public/notification-badge.png` is the separate 96×96 notification status-bar
asset: white logo strokes on a transparent background. Android masks its alpha
channel, so never use a filled app icon as the notification `badge`. The notification
body continues to use the color app icon. Both assets are precached by the service worker.

After changing the logo in `favicon.svg`, regenerate the badge from its foreground
geometry with `node apps/web/scripts/generate-notification-badge.mjs` from the repository
root (requires the Playwright Chromium installation above). Review the image and run
`pnpm web:verify`. The notification test checks the built asset's silhouette, offline
availability, and real service-worker push options; Android status-bar rendering still
needs a device check with a new notification after the updated worker activates.
