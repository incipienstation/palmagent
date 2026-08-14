---
name: ship
description: Final stage of the plan → start → verify → ship loop. Land verified work — small commits, open a PR into develop, and squash-merge once CI is green. Use when finishing a task. There is no publish or deploy in this repo.
---

# Ship

1. Commit small, with a clear message. Use a **GitHub noreply** git identity (never a personal
   email) — this repo is public-bound, so personal data must not enter its history.
2. Push the `feature/*` branch and open a PR with **base = `develop`** (never `main` directly).
3. Wait for CI (`validate`) to pass, then **squash-merge** into `develop`.
4. There is **no deploy or publish** here — the `palmagent` CLI is published elsewhere. To release
   to `main` (the branch consumers pull), open a **separate** `develop` → `main` PR as a deliberate
   promotion.
