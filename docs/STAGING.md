# Validation environments

A staging environment is an ordinary Palmagent package installation configured for
Preview and automatic updates. Maintainers use the same install, settings, update,
and doctor flows as other operators. There is no staging-specific deployment command,
private binding, candidate workflow, or per-release deployment approval.

## Set up a validation installation

Use the Palmagent install plugin to create an installation, or its setup plugin to
reconfigure an existing one. Choose a host and installation owner with independent
state when separation from everyday work is needed. Keep host values, credentials,
and runtime data outside the repository. The operator plugin manages HTTPS ingress.
A repository checkout, private staging configuration, or another maintainer's paths
are not required to operate the installation.

Ask the settings plugin to select **Preview** and enable **automatic updates**, or
choose those settings in the signed-in app. For maintainers using the CLI directly:

```bash
palmagent config set --channel preview
palmagent auto-update enable
palmagent auto-update status
```

Retain the installation's custom `--data-dir` on each command when applicable.
Channel and auto-update preferences are shared by installations using the same
Palmagent configuration home; use separate owner accounts or explicitly isolated
`PALMAGENT_HOME` values when installations must have different preferences.

## Follow Preview

Eligible product changes merged into `develop` trigger Preview preparation,
verification, and publication. The installed updater discovers the published version
when the signed-in app connects or returns to the foreground. Ordinary access reuses
a 15-minute discovery cache; **Check again** refreshes it. Merely waiting does not
trigger a check, and a tag or successful CI run does not prove installation.

Enabling automatic updates authorizes eligible updates under that saved policy;
do not add another staging approval for each release. Updates stay within the current
`x.x.x` line, coordinate compatible operator plugins, and preserve independent active
executions. Crossing a version line requires the ordinary update flow. Legacy
migration waits for idle. Changing channel alone does not install a release.

## Verify the installed result

Use `palmagent auto-update status` for the selected channel and last update result,
and `palmagent doctor` for runtime verification. Package activation verifies local
health, the exact build version and source commit, and PWA shell and entry-script
hashes against the installed package before reporting success. npm validates package
integrity during installation. Retained application activation records also capture
the verified identity and hashes.

Doctor checks the package identity and both local and configured public origins,
including HTTPS and served PWA hashes. A public-origin failure is reported separately
and does not turn a healthy local activation into an automatic rollback. Use
`palmagent terminal diagnose` when testing public WebSocket input/output and screen
restoration; it creates and cleans up a disposable diagnostic shell. Terminal and
browser interaction acceptance remain explicit tests, not background update tasks.

Record the version and source actually tested for a release review. Preview can advance
while validation is in progress; do not attribute old evidence to a newer version.
Exact Stable candidate verification remains part of the release workflow, including
its source and package checks. Preview acceptance does not prove a different Stable
artifact works. Unpublished candidate installation is not supported by the normal
package updater; do not restore a parallel staging deployment path to bypass it.

## Recovery and older records

An update failure pauses automatic retries. Use the doctor plugin to inspect the
result and the update plugin to repair the exact target through the normal updater.
Retained releases attempt to restore the previous application if activation fails;
verify the recorded result and live runtime. Legacy replacements have different
recovery limits. Package recovery never implies database rollback.

The retired staging command's private configuration, snapshots, and deployment
receipts are historical operator data. This repository cleanup does not delete them
or change running installations. They are not inputs to the automatic updater.
Preserve useful recovery evidence; do not treat an old staging receipt as the current
installation state or invoke an old deployment script against a newer installation.
