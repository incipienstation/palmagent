# CI build cache

Pull-request CI can reuse the built PWA in each web runner. Browser shards,
service-worker checks, and selected package checks still run on every PR check.
Release candidates keep their existing build and immutable-artifact workflow;
they do not consume this PR cache.

The `pr-pwa-v1` key includes the complete tracked repository tree, actual Node
version, OS/architecture, runner-image identity, Vite-related environment values,
and dotenv file contents. This conservative first version can miss after changes
that do not affect the PWA. Identical trees can reuse a cache across different
commit identities, subject to GitHub's branch/cache access rules. Source, product
version, dependency, build-script, and configuration changes invalidate the key.

Only an exact match with a valid checksum receipt skips the build. A missing,
partial, corrupt, or unavailable cache is discarded and the PWA is built normally.
Cache transfer steps have bounded timeouts and do not fail otherwise successful
checks. A fresh build is saved only after that runner's selected checks succeed.
The receipt lives outside the PWA and is not included in its served assets.

Each web job's **PWA build cache** summary records the usable cache result, restore
action outcome, build outcome, and actual build seconds. Actions step timings show
restore/save overhead. Compare both hits and misses when assessing elapsed time
and runner usage; a cached build never represents a cached test result. GitHub
retention, eviction, and branch visibility can turn a previous hit into a miss.

The initial [hosted experiment](https://github.com/incipienstation/palmagent/pull/303)
favored direct per-runner restores over adding a shared-build dependency. Its
same-source results do not predict the hit rate of normal development changes.
