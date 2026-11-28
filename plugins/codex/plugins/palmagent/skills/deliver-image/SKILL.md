---
name: deliver-image
description: Deliver a generated image or screenshot in a Palmagent task response. Use when returning a local raster image to the current Palmagent conversation, especially from a temporary artifact directory.
---

# Deliver an image to the current task

While the source file is available, submit it from the producing session on the
Palmagent host. Use the installed CLI from the [CLI bootstrap guidance](../.shared/bootstrap.md).
Check that `palmagent session --help` lists `attach-image` when using an older installation.

```bash
palmagent session attach-image --agent codex --file "<generated-image-path>"
```

For Claude Code use `--agent claude --session-id "${CLAUDE_SESSION_ID}"`. Codex
reads `CODEX_THREAD_ID`. Run from the task's original working directory or pass
`--cwd` with that directory. Preserve the session's provider home and installation
binding. A successful command prints ready-to-use Markdown for the final response.
Use that link when a filename is reused for revised images. The first delivered
version also resolves through its original absolute or sandbox-prefixed path.

The task must already exist in this installation. If delivery fails, report the error
or use a verified workspace preview while its source is available.
