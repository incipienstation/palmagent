# @palmagent/web

Mobile-first, **installable** PWA that drives the Palmagent backend over
**SSE (read) + REST (control)**. React + Vite + TypeScript, service worker via
`vite-plugin-pwa` (Workbox). The UI is **agent-agnostic** — it renders the
normalized `AgentEvent` and only ever uses agent kind for a label/colour.

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
   `tasks` snapshot frames, grouped by status.
3. **Task detail + steer** (`#/task/:id`) — scoped `GET /api/stream?task=:id`;
   live event log (assistant token deltas coalesced, tool calls/results, result)
   with follow-up, steer (surfaces *injected* mid-turn vs *queued* next-turn),
   stop (interrupt the turn, task stays resumable), cancel, and archive.

## How it talks to the backend

- **Contracts come from `@palmagent/shared`** (`AgentEvent`, `TaskState`,
  `Permission`, `Repo`, REST DTOs, `SseFrame`, and shared branding). Nothing is
  redefined. Type-only imports are erased by esbuild; shared intentionally uses
  source exports, so it needs no separate build step here.
- **`EventSource`, not fetch streaming.** On reconnect the browser resends
  `Last-Event-ID`; the server replays everything after it. The scoped stream
  additionally gates on the per-task `seq` (carried on the SSE `id:` line) so a
  replayed event is never rendered twice — no gaps, no dupes.
- **Service worker:** app shell is precached (cache-first) with a navigation
  fallback so the shell loads offline; `/api/*` is network-first **except**
  `/api/stream`, which is `NetworkOnly` (an open event-stream must never be
  cached). See `vite.config.ts`.

## Icons

`public/icon-*.png`, `apple-touch-icon.png`, and `favicon.svg` are reviewed
Palmagent source assets. Keep the maskable icon's glyph inside the adaptive-icon
safe zone.
