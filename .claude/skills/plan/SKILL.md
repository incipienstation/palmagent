---
name: plan
description: First stage of this repo's plan → start → verify → ship loop. Scope a change to the Palmagent marketplace BEFORE editing — understand the request, read CLAUDE.md plus the canonical skill / manifest / doc you will touch, and decide a small-commit plan. Use when picking up or beginning a task.
---

# Plan

1. Read `CLAUDE.md` (the rulebook) and the exact files you will change.
2. Decide WHAT changes — one of:
   - a **skill body** → edit the canonical `skills/<name>/SKILL.md` (never the generated copies);
   - a **manifest** → `.claude-plugin/marketplace.json`, `plugins/**/plugin.json`, or the Codex
     `plugins/codex/.agents/plugins/marketplace.json`;
   - a **Codex chip** → `plugins/codex/plugins/palmagent/skills/<name>/agents/openai.yaml`;
   - a **doc**.
3. Hold the **decoupling rule**: reference only the `palmagent` CLI; never name or describe any
   other repository, its paths, or its infrastructure. (CI's leak guard will fail otherwise.)
4. Plan small commits, then hand off to `/start`.
