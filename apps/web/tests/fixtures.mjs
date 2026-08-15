// Deterministic backend fixtures for the Playwright harness. These mirror the
// @palmagent/shared wire shapes (TaskState, AgentEvent, Repo, …) so the
// mock server feeds the real UI exactly what the real backend would — without a
// real backend or either CLI. All timestamps are fixed (no Date.now) so renders
// and screenshot baselines are reproducible run to run.
//
// Plain .mjs on purpose: the mock server (also .mjs) imports it directly, and it
// stays out of the app tsconfig so `pnpm typecheck` never touches it.

const T = 1_700_000_000_000; // fixed epoch base; offsets keep group ordering stable

// A deliberately long, space-free token used to stress overflow-wrap / the Radix
// ScrollArea horizontal-overflow guard for long, unbroken content.
const LONG_URL =
  "https://example.invalid/very/deep/path/segment/that/never/breaks/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?q=1234567890";

// A deliberately long, multi-line tool_result that overflows describeEvent's
// 400-char cap — so it collapses to a one-line summary AND becomes an expandable
// row (output mode). The unbreakable URL on the first line proves the EXPANDED
// detail still wraps inside the pane (the mobile horizontal-overflow contract).
const NGINX_PROBE = `+ curl -sS -D - -o /dev/null ${LONG_URL}
HTTP/2 200
server: nginx/1.27.0
content-type: text/event-stream
x-accel-buffering: no
cache-control: no-cache, no-transform
x-ratelimit-limit: 30
x-ratelimit-remaining: 29
# limit_req zone=api burst=10 nodelay applied; the /api/stream SSE location is excluded from the per-IP cap so the live stream is never throttled
# verified 50 concurrent /api/stream connections held open with zero 503s under the new nginx.conf rate-limit block`;

// A Claude AskUserQuestion the t-input task is paused on. One single-select + one
// multiSelect question so the QuestionCard snapshot exercises both control types.
/** @type {import("@palmagent/shared").AskQuestion[]} */
const INPUT_QUESTIONS = [
  {
    question: "Which styling approach should the new settings screen use?",
    header: "Styling",
    multiSelect: false,
    options: [
      { label: "Tailwind utilities", description: "Match the existing utility-first styling in the app." },
      { label: "CSS modules", description: "Scoped .module.css files per component." },
      { label: "Styled-components", description: "Runtime CSS-in-JS." },
    ],
  },
  {
    question: "Which sections should it include?",
    header: "Sections",
    multiSelect: true,
    options: [
      { label: "Account", description: "Profile, email, password." },
      { label: "Notifications", description: "Push + email preferences." },
      { label: "Appearance", description: "Theme and density." },
    ],
  },
];

/** @type {import("@palmagent/shared").Repo[]} */
export const repos = [
  { id: "repo-app", name: "sample-app", path: "/projects/sample-app", vcs: "git", defaultBaseRef: "main", createdAt: T },
  { id: "repo-notes", name: "notes", path: "/projects/notes", vcs: "none", defaultBaseRef: "", createdAt: T },
  { id: "repo-web", name: "web-client", path: "/projects/web-client", vcs: "git", defaultBaseRef: "develop", createdAt: T - 50_000 },
  { id: "repo-infra", name: "infra-tools", path: "/projects/infra-tools", vcs: "git", defaultBaseRef: "main", createdAt: T - 40_000 },
  { id: "repo-scratch", name: "scratchpad", path: "/projects/scratchpad", vcs: "none", defaultBaseRef: "", createdAt: T - 30_000 },
];

// One task per inbox group so the inbox snapshot exercises every status section,
// plus long titles/prompts to catch horizontal overflow.
/** @type {import("@palmagent/shared").TaskState[]} */
export const tasks = [
  {
    taskId: "t-input",
    repoId: "repo-app",
    agent: "claude",
    title: "Scaffold a new settings screen",
    prompt: "Add a settings screen — ask me about styling and which sections to include before building.",
    status: "awaiting_input",
    interrupted: false,
    sessionId: "sess-input-0007",
    branch: "agent/t-input",
    worktreePath: "/projects/sample-app/.palmagent/worktrees/t-input",
    permission: "auto-edit",
    model: "opus",
    effort: "high",
    pendingInput: { requestId: "req-ask-1", questions: INPUT_QUESTIONS },
    createdAt: T - 9500,
    updatedAt: T - 800,
    lastActivityAt: T - 800,
  },
  {
    taskId: "t-await",
    repoId: "repo-app",
    agent: "claude",
    title: "Awaiting approval on a destructive migration step",
    prompt: "Run the DB migration and confirm the destructive drop of the legacy events table.",
    status: "awaiting_approval",
    interrupted: false,
    sessionId: "sess-await-0001",
    branch: "agent/t-await",
    worktreePath: "/projects/sample-app/.palmagent/worktrees/t-await",
    permission: "auto-edit",
    model: "opus",
    effort: "high",
    createdAt: T - 9000,
    updatedAt: T - 1000,
    lastActivityAt: T - 1000,
  },
  {
    taskId: "t-run",
    repoId: "repo-app",
    agent: "claude",
    title: "Refactor the SSE hub fan-out",
    prompt: "Refactor hub.ts so a misbehaving subscriber can never break fan-out to the others.",
    status: "running",
    interrupted: false,
    sessionId: "sess-run-0002",
    branch: "agent/t-run",
    worktreePath: "/projects/sample-app/.palmagent/worktrees/t-run",
    permission: "full",
    model: "sonnet",
    createdAt: T - 8000,
    updatedAt: T - 500,
    lastActivityAt: T - 500,
  },
  {
    taskId: "t-queued",
    repoId: "repo-notes",
    agent: "codex",
    prompt: "Summarize today's meeting notes into action items and owners.",
    status: "queued",
    interrupted: false,
    permission: "readonly",
    createdAt: T - 7000,
    updatedAt: T - 7000,
    lastActivityAt: T - 7000,
  },
  {
    taskId: "t-idle-rich",
    repoId: "repo-app",
    agent: "claude",
    title: "Wire the web QA harness",
    prompt:
      "Set up a headless, isolated Playwright harness for apps/web that catches the mobile layout regressions we keep reintroducing (ScrollArea overflow, viewport scroll lock, banner/FAB overlap).",
    status: "idle",
    interrupted: false,
    sessionId: "sess-idle-0003",
    branch: "agent/t-idle-rich",
    worktreePath: "/projects/sample-app/.palmagent/worktrees/t-idle-rich",
    // Multi-PR task: a session that opened several PRs (exercises the "N PRs"
    // chip + the bottom sheet). Aggregate chip color = most urgent = the open
    // pending one (amber).
    prs: [
      { url: "https://github.com/acme/sample-app/pull/42", number: 42, repo: "acme/sample-app", title: "Wire the web QA harness", status: "open", checks: "pending", branch: "agent/t-idle-rich" },
      { url: "https://github.com/acme/sample-app/pull/41", number: 41, repo: "acme/sample-app", title: "Mock SSE+REST server for tests", status: "merged", checks: "passed", branch: "agent/harness-mock" },
      { url: "https://github.com/acme/sample-app/pull/43", number: 43, repo: "acme/sample-app", title: "WIP: visual snapshot baselines", status: "draft", checks: "none", branch: "agent/snapshots" },
    ],
    permission: "auto-edit",
    model: "opus",
    effort: "high",
    createdAt: T - 6000,
    updatedAt: T - 200,
    lastActivityAt: T - 200,
  },
  {
    taskId: "t-idle-interrupted",
    repoId: "repo-app",
    agent: "codex",
    title: "Interrupted across a deploy",
    prompt: "Add a 5-field cron parser with the standard dom/dow either-match quirk.",
    status: "idle",
    interrupted: true,
    sessionId: "sess-idle-0004",
    branch: "agent/t-idle-interrupted",
    worktreePath: "/projects/sample-app/.palmagent/worktrees/t-idle-interrupted",
    permission: "auto-edit",
    createdAt: T - 5500,
    updatedAt: T - 3000,
    lastActivityAt: T - 3000,
  },
  {
    taskId: "t-failed",
    repoId: "repo-notes",
    agent: "codex",
    prompt: "Build the project — but the build script is missing.",
    status: "failed",
    interrupted: false,
    sessionId: "sess-failed-0005",
    permission: "auto-edit",
    createdAt: T - 5000,
    updatedAt: T - 4000,
    lastActivityAt: T - 4000,
  },
  {
    taskId: "t-cancelled",
    repoId: "repo-app",
    agent: "claude",
    title: "Cancelled experiment",
    prompt: "Try a risky rewrite — cancelled by the user mid-turn.",
    status: "cancelled",
    interrupted: false,
    permission: "full",
    createdAt: T - 4500,
    updatedAt: T - 4400,
    lastActivityAt: T - 4400,
  },
  {
    taskId: "t-archived",
    repoId: "repo-app",
    agent: "claude",
    title: "Old finished task",
    prompt: "Long-since-completed task, retired to the archive.",
    status: "archived",
    interrupted: false,
    sessionId: "sess-arch-0006",
    permission: "auto-edit",
    createdAt: T - 4000,
    updatedAt: T - 3900,
    lastActivityAt: T - 3900,
  },
  {
    taskId: "t-run-charts",
    repoId: "repo-web",
    agent: "codex",
    title: "Migrate the dashboard to the new chart library",
    prompt: "Replace the legacy charts with the new lib and keep the existing prop API working.",
    status: "running",
    interrupted: false,
    sessionId: "sess-run-0101",
    branch: "agent/t-run-charts",
    worktreePath: "/projects/web-client/.palmagent/worktrees/t-run-charts",
    permission: "auto-edit",
    model: "gpt-5.5",
    effort: "medium",
    createdAt: T - 8600,
    updatedAt: T - 450,
    lastActivityAt: T - 450,
  },
  {
    taskId: "t-run-tf",
    repoId: "repo-infra",
    agent: "claude",
    title: "Roll the Terraform plan for staging",
    prompt: "Apply the staging VPC changes; show me the plan diff as you go.",
    status: "running",
    interrupted: false,
    sessionId: "sess-run-0102",
    branch: "agent/t-run-tf",
    worktreePath: "/projects/infra-tools/.palmagent/worktrees/t-run-tf",
    permission: "full",
    model: "opus",
    effort: "high",
    createdAt: T - 8300,
    updatedAt: T - 350,
    lastActivityAt: T - 350,
  },
  {
    taskId: "t-idle-tokens",
    repoId: "repo-web",
    agent: "codex",
    title: "Add dark-mode design tokens",
    prompt: "Introduce semantic color tokens and a dark theme; wire them through the component library.",
    status: "idle",
    interrupted: false,
    sessionId: "sess-idle-0103",
    branch: "agent/t-idle-tokens",
    worktreePath: "/projects/web-client/.palmagent/worktrees/t-idle-tokens",
    // Single-PR task: links straight out; chip color = open + checks passed (green).
    prs: [
      { url: "https://github.com/acme/web-client/pull/318", number: 318, repo: "acme/web-client", title: "Dark-mode design tokens", status: "open", checks: "passed", branch: "agent/t-idle-tokens" },
    ],
    permission: "auto-edit",
    model: "gpt-5.5",
    effort: "high",
    createdAt: T - 7600,
    updatedAt: T - 260,
    lastActivityAt: T - 260,
  },
  {
    taskId: "t-idle-nginx",
    repoId: "repo-infra",
    agent: "claude",
    title: "Tighten the nginx rate limits",
    prompt: "Add a per-IP rate limit to the public API vhost without breaking the SSE stream.",
    status: "idle",
    interrupted: false,
    sessionId: "sess-idle-0104",
    branch: "agent/t-idle-nginx",
    worktreePath: "/projects/infra-tools/.palmagent/worktrees/t-idle-nginx",
    permission: "auto-edit",
    model: "sonnet",
    createdAt: T - 7200,
    updatedAt: T - 320,
    lastActivityAt: T - 320,
  },
  {
    taskId: "t-idle-scratch",
    repoId: "repo-scratch",
    agent: "claude",
    title: "Draft release notes",
    prompt: "Turn the merged PR titles since the last tag into human-readable release notes.",
    status: "idle",
    interrupted: false,
    sessionId: "sess-idle-0105",
    worktreePath: "/projects/scratchpad",
    permission: "readonly",
    createdAt: T - 6800,
    updatedAt: T - 280,
    lastActivityAt: T - 280,
  },
  {
    taskId: "t-queued-leak",
    repoId: "repo-app",
    agent: "claude",
    title: "Audit the SSE reconnect path",
    prompt: "Look for listener leaks on EventSource reconnect and fix any you find.",
    status: "queued",
    interrupted: false,
    permission: "auto-edit",
    model: "opus",
    effort: "high",
    createdAt: T - 6900,
    updatedAt: T - 6900,
    lastActivityAt: T - 6900,
  },
  {
    taskId: "t-failed-react",
    repoId: "repo-web",
    agent: "codex",
    title: "Upgrade to React 19",
    prompt: "Bump React to 19 and fix the fallout.",
    status: "failed",
    interrupted: false,
    sessionId: "sess-failed-0106",
    branch: "agent/t-failed-react",
    worktreePath: "/projects/web-client/.palmagent/worktrees/t-failed-react",
    permission: "auto-edit",
    model: "gpt-5.5",
    createdAt: T - 5200,
    updatedAt: T - 4200,
    lastActivityAt: T - 4200,
  },
  {
    taskId: "t-cancelled-vpc",
    repoId: "repo-infra",
    agent: "codex",
    title: "Cancelled infra experiment",
    prompt: "Spin up a throwaway cluster — cancelled before it finished.",
    status: "cancelled",
    interrupted: false,
    permission: "full",
    createdAt: T - 4600,
    updatedAt: T - 4500,
    lastActivityAt: T - 4500,
  },
];

// Per-task scoped event streams (GET /api/stream?task=<id>). Each entry becomes
// an SSE `event` frame; the mock server stamps the per-task seq (the `id:` line)
// in array order. assistant_text payloads carry { text } (coalesced by the
// client); other kinds carry the fields format.ts/describeEvent reads.
/** @type {Record<string, Array<Pick<import("@palmagent/shared").AgentEvent, "kind" | "payload">>>} */
export const events = {
  "t-input": [
    { kind: "status", payload: { subtype: "init", model: "claude-opus", text: "session started" } },
    { kind: "assistant_text", payload: { text: "Before I scaffold the settings screen I need a couple of decisions from you." } },
    { kind: "question", payload: { requestId: "req-ask-1", questions: INPUT_QUESTIONS } },
  ],
  "t-idle-rich": [
    { kind: "status", payload: { subtype: "init", model: "claude-opus", text: "session started" } },
    { kind: "assistant_text", payload: { text: "## Plan\n\nI'll set up a **headless Playwright harness** — first inspect the build output and the layout-critical CSS.\n\n| Axis | Playwright | manual QA |\n|---|---|---|\n| Layout overflow | caught by `assertViewportLocked` | easy to miss |\n| Visual regressions | committed snapshots | none |\n\n- Build the `dist/` bundle\n- Assert the document never scrolls\n- Snapshot the result\n" } },
    { kind: "tool_call", payload: { name: "bash", command: ["pnpm", "--filter", "@palmagent/web", "build"] } },
    { kind: "tool_result", payload: { output: "vite v6.4.3 building for production…\n✓ 87 modules transformed.\ndist/index.html  0.71 kB\ndist/assets/index-DG46bSDI.js  388.20 kB │ gzip: 122.89 kB\n✓ built in 3.76s" } },
    // A long, space-free line: must wrap / scroll inside the pane, never widen the document.
    { kind: "tool_call", payload: { name: "fetch", command: LONG_URL } },
    { kind: "tool_result", payload: { output: `fetched ${LONG_URL} -> 200 OK (12,948 bytes)` } },
    { kind: "assistant_text", payload: { text: "The build is clean and the long URL above must stay inside the scroll pane. Wiring the config and specs now." } },
    { kind: "result", payload: { subtype: "success", result: "Harness scaffolded and passing.", num_turns: 3, usage: { input_tokens: 18234, output_tokens: 2890 } } },
  ],
  "t-run": [
    // The dispatch prompt rides the event stream (subtype "dispatch") so the
    // task view renders it without waiting for the inbox snapshot.
    { kind: "status", payload: { subtype: "dispatch", text: "Refactor hub.ts so a misbehaving subscriber can never break fan-out to the others." } },
    { kind: "status", payload: { subtype: "init", model: "claude-sonnet", text: "session started" } },
    { kind: "assistant_text", payload: { text: "Reading hub.ts and wrapping each subscriber call in try/catch so one dead socket can't break fan-out…" } },
    { kind: "tool_call", payload: { name: "read", command: "apps/server/src/hub.ts" } },
  ],
  "t-await": [
    { kind: "status", payload: { subtype: "init", model: "claude-opus", text: "session started" } },
    { kind: "assistant_text", payload: { text: "This migration drops the legacy events table. That is destructive and irreversible — requesting approval before proceeding." } },
    { kind: "approval_request", payload: { tool: "bash", command: "psql -c 'DROP TABLE legacy_events;'", reason: "destructive schema change" } },
  ],
  "t-failed": [
    { kind: "status", payload: { subtype: "init", text: "session started" } },
    { kind: "tool_call", payload: { name: "bash", command: ["npm", "run", "build"] } },
    { kind: "error", payload: { message: "npm ERR! Missing script: \"build\" — no build step is defined for this project." } },
    { kind: "result", payload: { subtype: "error", is_error: true, result: "Turn failed: missing build script.", num_turns: 1 } },
  ],
  "t-run-charts": [
    { kind: "status", payload: { subtype: "dispatch", text: "Replace the legacy charts with the new lib and keep the existing prop API working." } },
    { kind: "status", payload: { subtype: "init", model: "gpt-5.5", text: "session started" } },
    { kind: "assistant_text", payload: { text: "Mapping the legacy <Chart> props onto the new library's API so existing call sites don't change." } },
    { kind: "tool_call", payload: { name: "read", command: "src/components/Chart.tsx" } },
    { kind: "tool_result", payload: { output: "export function Chart({ series, axis, legend }: ChartProps) { /* 240 lines */ }" } },
    { kind: "tool_call", payload: { name: "bash", command: ["pnpm", "add", "@nivo/line@^0.88.0"] } },
  ],
  // Drives the output-mode specs: a raw status (compact hides it), tool work, and
  // a long multi-line tool_result that collapses → tap to expand (default), shows
  // expanded up front (verbose). Lives on an idle task with no committed event-log
  // snapshot so it doesn't perturb the inbox/task-detail baselines.
  "t-idle-nginx": [
    { kind: "status", payload: { subtype: "init", model: "claude-sonnet", text: "session started" } },
    { kind: "assistant_text", payload: { text: "Adding a per-IP `limit_req` to the public API vhost, then probing the SSE stream to confirm it's exempt from the cap." } },
    { kind: "tool_call", payload: { name: "bash", command: ["nginx", "-t"] } },
    { kind: "tool_result", payload: { output: NGINX_PROBE } },
    { kind: "result", payload: { subtype: "success", result: "Per-IP rate limit added; SSE stream verified unthrottled.", num_turns: 2, usage: { input_tokens: 14820, output_tokens: 2110 } } },
  ],
  "t-idle-tokens": [
    { kind: "status", payload: { subtype: "init", model: "gpt-5.5", text: "session started" } },
    { kind: "assistant_text", payload: { text: "Adding semantic tokens (--color-bg/-fg/-accent) and a [data-theme=dark] block, then threading them through the component library." } },
    { kind: "tool_call", payload: { name: "write", command: "src/styles/tokens.css" } },
    { kind: "tool_result", payload: { output: "wrote src/styles/tokens.css (62 lines)" } },
    { kind: "assistant_text", payload: { text: "Done — opened a PR with the token layer and a dark theme toggle." } },
    { kind: "result", payload: { subtype: "success", result: "Dark-mode tokens added; PR opened.", num_turns: 4, usage: { input_tokens: 22140, output_tokens: 3510 } } },
  ],
};

/** @type {import("@palmagent/shared").AgentUsage[]} */
export const usage = [
  { agent: "claude", taskCount: 11, turnCount: 34, totalCostUsd: 12.8431, durationMs: 2_412_000, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
  { agent: "codex", taskCount: 7, turnCount: 16, totalCostUsd: 0, durationMs: 0, inputTokens: 1_284_550, cachedInputTokens: 1_010_330, outputTokens: 142_870, reasoningOutputTokens: 71_900 },
];

/** @type {import("@palmagent/shared").Routine[]} */
export const routines = [
  {
    id: "r-standup",
    repoId: "repo-notes",
    agent: "codex",
    title: "Morning standup digest",
    prompt: "Summarize open tasks and yesterday's commits into a short standup.",
    permission: "readonly",
    preset: "weekdays",
    schedule: "0 9 * * 1-5",
    enabled: true,
    lastRunAt: T - 86_400_000,
    nextRunAt: T + 3_600_000,
    createdAt: T - 600_000,
    updatedAt: T - 600_000,
  },
  {
    id: "r-triage",
    repoId: "repo-app",
    agent: "claude",
    title: "On-demand dependency triage",
    prompt: "Check for outdated dependencies and open a PR if any are safe to bump.",
    permission: "auto-edit",
    preset: "manual",
    schedule: "",
    enabled: true,
    lastRunAt: T - 7_200_000,
    createdAt: T - 1_200_000,
    updatedAt: T - 1_200_000,
  },
  {
    id: "r-smoke",
    repoId: "repo-app",
    agent: "claude",
    title: "Hourly smoke suite",
    prompt: "Run the smoke suite against staging and ping me only if it goes red.",
    permission: "readonly",
    preset: "hourly",
    schedule: "0 * * * *",
    enabled: true,
    lastRunAt: T - 1_800_000,
    nextRunAt: T + 1_800_000,
    createdAt: T - 900_000,
    updatedAt: T - 900_000,
  },
  {
    id: "r-backup",
    repoId: "repo-infra",
    agent: "claude",
    title: "Nightly backup verification",
    prompt: "Verify last night's DB backup restores cleanly into a scratch instance.",
    permission: "auto-edit",
    preset: "daily",
    schedule: "0 3 * * *",
    enabled: true,
    lastRunAt: T - 80_000_000,
    nextRunAt: T + 6_400_000,
    createdAt: T - 1_500_000,
    updatedAt: T - 1_500_000,
  },
  {
    id: "r-deps-weekly",
    repoId: "repo-web",
    agent: "codex",
    title: "Weekly dependency report (paused)",
    prompt: "Produce a report of outdated dependencies and known CVEs.",
    permission: "readonly",
    preset: "weekly",
    schedule: "0 14 * * 3",
    enabled: false,
    lastRunAt: T - 500_000_000,
    createdAt: T - 2_000_000,
    updatedAt: T - 300_000,
  },
  {
    id: "r-custom",
    repoId: "repo-app",
    agent: "codex",
    title: "Inbox sweep (business hours)",
    prompt: "Triage any tasks still awaiting input and summarize what's blocked.",
    permission: "readonly",
    preset: "custom",
    schedule: "*/30 9-18 * * 1-5",
    enabled: true,
    lastRunAt: T - 1_700_000,
    nextRunAt: T + 100_000,
    createdAt: T - 1_000_000,
    updatedAt: T - 1_000_000,
  },
];

// Run history per routine (most-recent first) — served by GET /api/routines/:id/runs.
/** @type {Record<string, import("@palmagent/shared").RoutineRun[]>} */
export const routineRuns = {
  "r-standup": [
    { id: 3, routineId: "r-standup", firedAt: T - 86_400_000, status: "fired", taskId: "t-idle-rich" },
    { id: 2, routineId: "r-standup", firedAt: T - 172_800_000, status: "skipped", note: "missed while the server was down" },
    { id: 1, routineId: "r-standup", firedAt: T - 259_200_000, status: "fired", taskId: "t-run" },
  ],
  "r-triage": [
    { id: 4, routineId: "r-triage", firedAt: T - 7_200_000, status: "manual", taskId: "t-idle-rich" },
  ],
  "r-smoke": [
    { id: 8, routineId: "r-smoke", firedAt: T - 1_800_000, status: "fired", taskId: "t-run-tf" },
    { id: 7, routineId: "r-smoke", firedAt: T - 5_400_000, status: "fired", taskId: "t-idle-nginx" },
    { id: 6, routineId: "r-smoke", firedAt: T - 9_000_000, status: "skipped", note: "missed while the server was down" },
    { id: 5, routineId: "r-smoke", firedAt: T - 12_600_000, status: "fired", taskId: "t-idle-rich" },
  ],
  "r-backup": [
    { id: 10, routineId: "r-backup", firedAt: T - 80_000_000, status: "fired", taskId: "t-idle-nginx" },
    { id: 9, routineId: "r-backup", firedAt: T - 166_400_000, status: "fired", taskId: "t-idle-nginx" },
  ],
  "r-custom": [
    { id: 11, routineId: "r-custom", firedAt: T - 1_700_000, status: "fired", taskId: "t-idle-rich" },
  ],
};
