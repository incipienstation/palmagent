# CI PWA builds

Pull-request CI builds the PWA once in the `pwa` job and shares it with all four
browser shards, the service-worker check, package validation, and both standalone
checks. Their tests still run on every selected check. Release candidates keep
their existing build and immutable-artifact workflow; they do not consume PR
artifacts or this cache.

The producer uses the same change-selection code as the scope gate and starts
alongside it, avoiding an extra serial dependency. Unselected scopes do not
install dependencies or build/upload a PWA. Consumers prepare concurrently: browsers install their
dependencies and Chromium before looking for the artifact. A bounded wait locates
`ci-pwa` only within the current workflow run and downloads its immutable artifact
ID directly from the archive endpoint. Incomplete listings and transient archive errors
are retried with bounded backoff. The artifact ID stays pinned across download retries.
This avoids making runner setup wait for the build job to finish. The wait
requires read-only Actions access and fails if usable output does not arrive
within the deadline, or if artifact identity or API access is invalid; consumers
never silently rebuild. The final `validate` gate
also requires the selected `pwa` job to succeed.

The artifact carries a receipt outside the served PWA. Every consumer checks its
Git source tree and the complete output file list and SHA-256 hashes. Static web
assets can be consumed on different runner images and architectures; native
binaries and addons keep their separate platform-specific builds and checks.
Consumer-only reruns reuse the retained artifact from the same run and source.
On a full rerun, GitHub may discard uploads from rerun jobs; the producer then
restores its exact cache or builds a fresh upload. If a valid artifact remains
visible, the producer reuses it too instead of replacing files consumers may be
downloading. For missing or expired output, include the producer in the rerun;
consumers wait for the fresh upload. Missing or invalid output never bypasses
the final gate. See [GitHub's job rerun behavior](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).

The producer retains the exact-input cache as an optional build optimization.
The `pr-pwa-v2` key includes the complete tracked repository tree, actual Node
version, OS/architecture, runner-image identity, Vite-related environment values,
and dotenv file contents. Source, product version, dependencies, build scripts,
and configuration changes invalidate the key. Different commits with identical
trees can reuse it, subject to GitHub's branch/cache access rules.

Only an exact match with a valid source/checksum receipt skips the producer build.
A missing, partial, corrupt, or unavailable cache is discarded and built normally.
Cache transfer steps have bounded timeouts and do not fail otherwise successful
checks. A fresh build can be cached before consumer tests finish: this caches
build output only, never a successful test result or release approval.

The producer's **PWA build cache** summary records the usable cache result, restore
outcome, build outcome, and actual build seconds. Consumers log artifact wait time.
Compare workflow elapsed time and summed runner time, including setup, artifact
transfer, queueing, and both cache hits and misses. The earlier
[per-runner cache experiment](https://github.com/incipienstation/palmagent/pull/303)
did not measure this overlapping producer/consumer arrangement.

## Public documentation checks

Extended local verification and pull request CI scan repository Markdown for product-comparison
phrases. To flag a standalone product name, add it on its own line in the
`PALMAGENT_DOC_EXCLUDED_NAMES` Actions repository variable. Use public names only.
The same environment variable configures the extended local check. Matches report the file
and line. Dedicated license and notice files retain their attributions. Review the meaning of new names and links as part of the documentation change.

## Merging into develop

When a task PR is ready to merge, submit its number and verified head from the repository checkout:

```bash
node scripts/queue-develop.mjs <pr-number> <verified-head>
```

The command prints the Actions run URL and follows it to completion. The merge job and
Preview preparation share one turn at a time. PR CI can run concurrently, and Preview
releases its turn before building and publishing the candidate. The worker requests a
squash merge only after the current head passes the required check against the latest
`develop`. If verification depends on a particular base, pass its full SHA as a third
argument. A changed source then returns to its owner for verification.

Use the printed run URL to inspect a failure or resume monitoring after disconnecting.
A conflicting PR needs a resolution from the task owner and a new request for the
reviewed head. The queue uses the repository-scoped App configured for Preview.
