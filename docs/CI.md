# CI PWA builds

Pull-request CI builds the PWA once in the `pwa` job and shares it with all four
browser shards, the service-worker check, package validation, and both standalone
checks. Their tests still run on every selected check. Release candidates keep
their existing build and immutable-artifact workflow; they do not consume PR
artifacts or this cache.

Consumers prepare their runners concurrently with `pwa`: browsers install their
dependencies and Chromium before looking for the artifact. A bounded wait locates
`ci-pwa` only within the current workflow run and downloads its immutable artifact
ID. This avoids making runner setup wait for the build job to finish. The wait
requires read-only Actions access and fails on missing, expired, ambiguous, or
unavailable artifacts; consumers never silently rebuild. The final `validate` gate
also requires the selected `pwa` job to succeed.

The artifact carries a receipt outside the served PWA. Every consumer checks its
Git source tree and the complete output file list and SHA-256 hashes. Static web
assets can be consumed on different runner images and architectures; native
binaries and addons keep their separate platform-specific builds and checks.
Failed-job reruns can reuse the artifact from the same run and source. If it has
expired, rerun the producer as well. A producer rerun replaces the named artifact.

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
