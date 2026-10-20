# Validation environments

For host operations, record the deployed commit or immutable artifact and verify runtime health
separately from merge or CI status. Installations follow their saved channel and update settings.

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

Message submissions wait through a brief maintenance window or connection interruption for up
to two minutes. The browser retains the submitted text, attachments and request ID, shows the
wait, and lets the user stop automatic retries. A pending submission delays automatic screen
replacement until it settles. If the wait expires, the input remains available for recovery;
closing the browser is not a background delivery mechanism.

Task creation and message submission carry a separate compatibility version defined in
`packages/shared/src/http.ts`. Matching message contracts can cross application build versions;
other writes still require the current screen. Incompatible changes to either submission's
request, response or delivery semantics must advance that contract. Authentication, maintenance
admission and the original target run remain enforced. Retrying an accepted request only reads
its stored result and never retries an uncertain provider delivery.

## Follow Preview

Eligible product changes merged into `develop` trigger Preview preparation,
verification, and publication. The installed updater discovers the published version
when the signed-in app connects or returns to the foreground. Ordinary access reuses
a 15-minute successful discovery cache; failed checks are retried on the next access
after one minute. **Check again** bypasses either cache. Merely waiting does not
trigger a check, and a tag or successful CI run does not prove installation.

Failed lookups retain a safe source and error category in `auto-update status`, and
Settings shows the corresponding cause. A plugin inventory timeout gets one automatic
retry with a ten-second limit, shared across the managers in that check. Persistent
failures still report their cause; update commands are not retried this way.
Plugin inventory failures, missing commands,
timeouts, registry failures and incompatible releases are distinct; command output,
credentials and private paths are not included. Older failure records may have no
details; check again to obtain a current result.
The web host logs an `update_discovery_failed` event once per failed result, so a
later successful check does not erase its diagnostic evidence.

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

The native daemon allows 60 seconds for web startup readiness, including cold starts
during an update. Restart requests allow 90 seconds for shutdown, startup, and control
overhead; current clients wait 95 seconds for the response. A process that is alive but
has not reported readiness is still starting. Expired startup waits retain normal
recovery and update rollback behavior without replaying agent work.

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
