# Locate and check the Palmagent CLI

Read this reference when an operator skill needs the CLI. The invoking skill owns the
requested operation and its diagnostic exceptions. Handle CLI discovery and bootstrap
internally; never ask the user to install the CLI, run these commands, or edit configuration.

## Select the channel and exact command

Before choosing a bootstrap package, read `~/.palmagent/config.json` (or `config.json`
under `PALMAGENT_HOME` when set). Honor an explicitly requested channel; otherwise retain
its saved `channel` or the existing installation's legacy channel. Only a fresh user
with no choice defaults to Stable. Reject malformed JSON, unsupported `schemaVersion`,
or invalid channels rather than guessing or resetting preferences.

Use the installed CLI when available. If bootstrap is needed, resolve the chosen npm tag
(`latest` for Stable, `next` for Preview) to one exact published version. Use
`palmagent@<resolved-version>` for every bootstrap command. Moving tags are for discovery,
not the installation target. Never silently switch channels or substitute a moving `npx`
version after failure. Preview requires an explicit choice, is available to everyone, and
is not a fallback when Stable is unavailable.

Keep the selected installation's custom `--data-dir` throughout. Substitute the resolved
internal command for `<cli>` in the invoking skill. Temporary diagnostic or planning
commands must not replace the installed service package.

## Check compatibility before CLI operations

Read the invoking installed plugin's manifest at `../../.claude-plugin/plugin.json` or
`../../.codex-plugin/plugin.json`, relative to that skill directory, then run:

```bash
<cli> compatibility --plugin-version <installed-plugin-version>
```

The CLI and plugin must share the same `x.x.x`, including prereleases. Require exit 0
before the skill's CLI operation. If the command is absent, the manifest is unreadable,
or the check fails, explain the compatible released pair needed and retain installed
state. This check does not update either component; native plugin managers own plugin
installation. Follow the invoking skill's explicit read-only diagnostic exception when
it applies, without treating that exception as permission for host changes.

## Preserve user settings

Read effective settings with `<cli> config get`, retaining a custom `--data-dir`.
This is read-only. Shared settings live outside plugin/package caches and service data,
and survive updates, plugin reinstall, and service removal. Never edit `install.env` to
change channels. For a preference-only request, use the `settings` skill. Initialization
and service changes belong to the requested operation, not to CLI discovery.
