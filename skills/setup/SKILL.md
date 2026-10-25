---
name: setup
description: Reconfigure an existing Palmagent installation, adopt its host ingress, or change its domain, port, concurrency or repository roots. Use install for a new instance and doctor for diagnosis.
---

# Reconfigure Palmagent

Read [CLI bootstrap](../.shared/bootstrap.md) and [host ingress](../.shared/ingress.md).
The CLI manages the application; this plugin manages the host connection. Existing proxy
files and certificates survive CLI updates and must be inspected before adoption or edits.

Inspect saved configuration and the connection contract. Apply requested changes only;
retain the release channel, custom data directory and unspecified values. `--data-dir`
selects an installation; it does not move persistent data. Use `install` if none exists.

For a domain or port change, prepare and record both the application and ingress changes
before activation. Keep the old route until the new one is verified. A new domain changes
passkey identity and needs a new device enrollment link. Optional settings use existing
values or CLI defaults, not extra configuration questions.

Preview application changes:

```bash
<cli> setup --dry-run --non-interactive <changed-config-flags>
```

Review the planned files, configuration differences, bootstrap changes and activation
effects before applying. Native setup preserves saved provider, proxy, CA and locale
environment settings even when the invoking shell differs. Older CLIs may show only a
generic preview and rebuild these values from their caller: privately reproduce the saved
allowlisted environment, including absent values, and compare effective configuration after
setup. Do not print credentials or infer preservation from an unchanged `install.env` alone.

For authorized work, initialize preferences with `<cli> config init` using the same data
directory, then apply:

```bash
<cli> setup --non-interactive <changed-config-flags>
<cli> connection --data-dir <installed-data-dir>
```

Setup may migrate an existing package to the native daemon during an idle window;
this verifies lingering and user-service delegation, registers its user bootstrap, and
removes obsolete system services after health verification using one-time sudo.
Existing native system services migrate through this same idle setup path. The CLI enforces activity checks for service activation. Preserve active work and do not
manually restart services to bypass a refusal. Configure/adopt ingress through its actual
owner, following the shared reference's ownership, validation and recovery procedure.
If only application settings changed, an unchanged route requires no rewrite or reload.
Verify runtime and public HTTPS separately. For a changed domain mint a fresh link with
`<cli> passkey` only after HTTPS succeeds. Report any retained old routes or recovery work.
