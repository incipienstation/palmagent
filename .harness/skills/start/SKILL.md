---
name: start
description: Start Palmagent implementation in a task-owned worktree on feature/* from develop.
---

# Start

Reuse the task's linked worktree, or fetch `origin develop` and create one:

```bash
git worktree add .harness/worktrees/<slug> -b feature/<slug> origin/develop
```

Use a platform-managed worktree when required by its hooks. Keep manual task worktrees under
`.harness/worktrees/`. Compare checkout instructions with those already read; load only differences.
Implement in the task worktree, then [verify](../verify/SKILL.md).
