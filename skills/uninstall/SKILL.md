---
name: uninstall
description: Remove an existing Palmagent runtime and clean up its verified host ingress resources while preserving shared services and data unless purge is requested.
---

# Remove Palmagent

Read [CLI bootstrap](../.shared/bootstrap.md) and [host ingress](../.shared/ingress.md).
Inspect the selected installation and its ingress ownership receipt before removal.
A removal request preserves application data unless the user explicitly requests purge.

Preview `<cli> uninstall --dry-run --non-interactive --data-dir <installed-data-dir>`.
For authorized removal, run the same command without `--dry-run`; add `--purge` only
when data deletion is requested. If active executions or terminals block it, retain the
route and let work finish; do not bypass the refusal by killing sessions.

After successful application removal, clean up exclusively owned, unchanged ingress
resources using the shared reference. The CLI preserves all proxy/TLS resources, even
with `--purge`. Keep shared or manually modified resources and report why. Store the
receipt outside application data so recovery survives purge. Report runtime removal,
ingress cleanup and data retention separately.
