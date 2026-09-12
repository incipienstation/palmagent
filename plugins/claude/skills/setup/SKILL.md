---
name: setup
description: Use when an operator wants to reconfigure or change the settings of an EXISTING Palmagent install on this host — phrases like "change the dispatcher domain", "reconfigure palmagent", "update the repo roots / port / concurrency", or "re-render the systemd units or nginx vhost". Not for moving persistent data, first-time install (use install), or diagnosing a broken instance (use doctor).
---

# Reconfigure an existing Palmagent instance

Thin wrapper over the `palmagent` CLI's `setup` subcommand. The CLI owns
the deterministic work — re-rendering the systemd units + nginx vhost from the
new config and re-running certbot if the domain changed. Do **not** edit unit
files or nginx config by hand in chat; drive the CLI.

## 1. Locate the CLI

Read and follow the [shared CLI bootstrap guidance](../.shared/bootstrap.md).
Use its exact command, saved channel, compatibility check, and custom data directory.

## 2. Resolve the requested changes

`setup` is idempotent but it re-renders host config and may restart the service.
Before running:

- Read the existing settings and apply the user's requested changes to domain,
  internal port, concurrency, or repo roots. Retain unspecified values and ask
  only about missing required information or an unresolved choice.
  `--data-dir` locates an existing custom installation; it does not move data.
  Note that **changing the domain re-runs certbot** and requires the new
  domain's DNS A-record + ports 80/443 to be live first.
- Warn that re-rendering may restart the web unit; in-flight agent turns reattach
  on a web-only restart. A runner unit/artifact change restarts the runner and
  interrupts active turns; a domain/auth change is operator-visible.

To preview the re-rendered units + nginx vhost without applying:

```bash
<cli> setup --dry-run --non-interactive <changed-config-flags>
```

## 3. Run it

For this authorized operation, run `<cli> config init` with the same custom
`--data-dir` before applying service changes. It migrates legacy preferences without
overwriting an existing user file; do not initialize during a dry-run-only request.

```bash
<cli> setup --non-interactive <changed-config-flags>
```

Replace `<changed-config-flags>` with the requested values using the supported flags
from `<cli> setup --help`. Reuse the existing authorization under the shared guidance;
if runner changes would interrupt active work, defer until it finishes unless that
interruption is already authorized.

## 4. Report

Relay the CLI's summary of what was re-rendered and whether certbot ran. If it
exits non-zero, read its remediation output verbatim and propose the named fix.
If the operator instead reports the instance is now broken, hand off to the
`doctor` skill.
