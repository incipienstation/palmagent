---
name: routine
description: Create, inspect, change, pause, delete, or run Palmagent routines from natural language. Supports scheduled agent tasks and scripts on an existing Palmagent installation.
---

# Palmagent routines

Translate the user's requested automation into a routine on their existing instance.
Use the [shared CLI bootstrap guidance](../.shared/bootstrap.md) to find the compatible
installed CLI. Run `<cli> routine --help` to establish supported capabilities; if the
installed version lacks this command, explain that an application update is needed.
Do not substitute OS cron or edit the database.

## Resolve intent

Use `<cli> routine spaces` for registered space IDs and the scheduler timezone, and
`<cli> routine list` to avoid duplicates and identify an existing routine. Pass the same
`--data-dir` for a custom installation. Ask only for missing choices that matter:
space, intended action, cadence, or an ambiguous timezone. Do not interpret a local
time as server time silently; explain the conversion and any daylight-saving limitation.

Choose an agent task for work requiring reasoning, or a script for deterministic code
execution. Script routines make no AI call. Each routine has one execution type;
sequences mixing scripts and agents are not supported.

Scripts run as the installation owner with `/bin/sh`, in a fresh isolated Git worktree
from the space's base ref. Plain folders run in place. Dependencies/untracked files in
the original Git checkout are not copied. Use a committed script with an explicit
interpreter (for example `python3 scripts/report.py`), or a self-contained command.
Respect the user's scope for file changes, network calls, and recurring side effects.
Do not embed credentials in commands or print secrets into retained output.

## Create or change

Write JSON using a file-writing tool or a quoted heredoc, preserving script text without
shell interpolation. Send it with `routine create --file <path>` or
`routine update <id> --file <path>`. `--file -` accepts stdin. These commands output JSON.
`--dry-run` checks input shape only; it does not validate the space or run the script.

Agent example:

```json
{"repoId":"<space-id>","agent":"codex","prompt":"Review recent changes and summarize follow-up work.","preset":"weekdays","hour":9,"title":"Morning review"}
```

Script example:

```json
{"repoId":"<space-id>","kind":"script","script":{"command":"node scripts/report.mjs","timeoutSeconds":300},"preset":"daily","hour":9,"title":"Daily report"}
```

Cadence supports `hourly`, `daily`, `weekly`, `weekdays`, `manual`, or `custom` with
five-field `schedule` cron. Weekly accepts `dayOfWeek` (Sunday 0); time presets accept
`hour` (0-23). Use custom cron for minutes. `enabled:false` creates a paused routine.
Agent options include `permission`, `model`, and `effort`; use installed agent choices,
not invented model names. Script timeout is 1-3600 seconds, default 300.
The execution type is fixed after creation. Updates accept script settings or agent
prompt/settings, title, cadence and enabled state. A script update replaces its command
settings: read the routine first and preserve the command when changing only its timeout.
Do not recreate a routine merely
to change its cadence.

Creating a routine schedules future runs but does not execute it immediately. Continue
with `routine run <id>` only if the user requested a run or test. An explicit request
to create a clearly specified recurring action authorizes saving that schedule; do not
add a redundant confirmation. For a design-only request, show the proposed definition.

## Verify and manage

Read back `routine get <id>` and report its name, type, space, schedule/timezone, enabled
state, and next run when present. Commands `enable`, `disable`, `delete`, `run`, `stop`, and
`runs` take the ID. Inspect the exact routine before updating or deleting it.
If a mutation times out, read back before retrying so a lost response cannot duplicate it.

After a requested run, inspect `routine runs <id>`: agent runs link to a task; scripts
record running/succeeded/failed/interrupted, exit code, bounded combined output, and a
retained worktree path. A run request being accepted is not completion. Scripts have
no overlapping runs per routine and share four execution slots. Missed or capacity-limited
scheduled runs are skipped, not queued for catch-up. Server shutdown interrupts scripts;
restart does not retry them. Disabling only prevents future scheduled runs; `stop` interrupts the current script.
