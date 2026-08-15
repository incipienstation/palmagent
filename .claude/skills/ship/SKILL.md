---
name: ship
description: Final stage of Palmagent's plan → start → verify → ship loop. Deliver verified work as focused commits and a pull request into develop while preserving explicit approval gates. Use when finishing a task.
---

# Ship

1. Commit small, with a clear message. Confirm the configured author identity is the approved
   public project identity before committing.
2. Push the `feature/*` branch and open a PR with **base = `develop`** (never `main` directly).
3. Wait for CI to pass and report the evidence. Do not merge without explicit human approval.
4. Do not infer publication, visibility changes, or deployment from a green PR. Each is a separate
   action with its own explicit approval. Promote `develop` to `main` with a dedicated PR.
