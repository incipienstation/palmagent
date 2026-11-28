# Runtime language experiment

This experiment compares Palmagent's existing model-catalog projection with small Go and
Rust ports. It does not change the application, launch a provider, read account data, or
access a product database. The ports and socket servers are experimental fixtures, not
production migration implementations.

## Run

Use Linux ARM64 or x64, Python 3.10 or newer, the exact Node version in `.nvmrc`, the
repository's Rust toolchain, and Go 1.24 or newer. Install repository dependencies with
`pnpm install --frozen-lockfile`. Install Go separately from a verified official archive;
the runner never installs a global toolchain.

```sh
python3 scripts/experiments/runtime-languages/run.py \
  --go /path/to/go/bin/go \
  --node /path/to/node \
  --rounds 4 --requests 1000 \
  --native \
  --out /tmp/runtime-language-report.json
```

The output must not already exist. The runner prints its private temporary directory and
retains source copies, compiler logs, Cargo timing reports and build caches there for
inspection. It never edits the source checkout or cleans a shared build cache. Remove the
specific printed directory after inspecting it when its artifacts are no longer needed.
Omit `--native` to run only the small parser comparison. Do not run builds or other
benchmarks concurrently with a measurement.

## What is measured

- **Cold:** empty experiment build caches, with dependency/toolchain downloads excluded.
  Rust ships a precompiled standard library; an empty Go build cache includes compilation
  of standard-library packages. This is a toolchain cold-start comparison, not equal work.
- **No change:** repeat the same build with warm caches.
- **Logic edit:** alternate the real parser's string limit between 160 and 159 UTF-16 units.
- **Contract value edit:** alternate an exported wire protocol constant between 1 and 2
  in a separate local module/package/crate. This is not a schema-shape migration benchmark.
- **Feedback:** build plus the complete synthetic parity corpus, including server startup.
  Download, source editing and report-writing time are outside this sum.
- **Runtime:** private Unix-socket NDJSON request/response for an eight-model catalog,
  after 1,000 warm-up requests, with one and four simultaneous clients. Each candidate
  serializes a complete response before writing it. The Python driver validates replies;
  throughput includes client validation and can be client-limited. Latency stops before
  client JSON decoding. The protocol is intentionally smaller than production HTTP.
- **Existing native code (`--native`):** the current Rust workspace's development build
  and the existing packaging script for the host's one Linux platform. Both build the
  daemon and application runtime. An application error-message edit and a separate
  empty Git commit distinguish source changes from release-identity invalidation.

The TypeScript build includes a standalone strict `tsc --noEmit` check of the copied
projection/contracts and an esbuild bundle of its socket wrapper. It does not typecheck
the whole Palmagent server. There is no resident TypeScript compiler or bundler; watch-mode
feedback may differ. Go uses its default optimized build. Rust is measured separately
with the development profile and the repository's ThinLTO release settings. These are
usable development/distribution choices, not equivalent optimizer configurations.

Compiler jobs are capped at two. Go's compiler uses `GOMAXPROCS=2`; runtime servers use
their normal runtime defaults. Each language has its own normal socket-concurrency model
(Node event loop, Go goroutines, Rust threads). Results include process startup, server
CPU ticks, idle/warm/high-water RSS, driver CPU/high-water RSS, and host load samples.
CPU ticks have the operating system's accounting resolution. Driver peak RSS is cumulative
for the run and is not an independently sampled per-candidate memory requirement. A shared
host's scheduling and filesystem cache remain confounders. Four rounds rotate the four
candidates through each execution position; cold builds have one sample each.

## Behavior and scope

The TypeScript projection and types are copied from current source; their SHA-256 hashes
and the source commit are recorded. Native Node type stripping runs the copied projection
as the oracle, independently of the measured esbuild bundle. The baseline corpus covers
fallback fields, type filtering, hidden/default flags, deduplication, bounded model/effort
lists, whitespace, Unicode, and truncation through a surrogate pair. No provider responses
or other real account content are used.

Every measured edited build must pass that corpus under the edited policy and wire value.
Malformed JSON is followed by a valid request on the same connection. Separate adversarial
probes expose JSON-decoder differences for escaped lone surrogates and overflowing numeric
metadata. Probe mismatches are reported explicitly; they are migration blockers, not
silently accepted production compatibility. Go-only builds also assert that the already
built Rust executable's content and modification time remain unchanged.

The measured ports use different JSON libraries and allocation strategies. They do not
include the model cache, provider subprocess, authentication, persistent state, recovery,
HTTP framing or the application's other work. This parser experiment cannot establish
full-server performance, end-to-end provider latency, database durability, migration
readiness, or release/install/update compatibility. The native packaging measurement
produces the actual selected-platform native binaries and manifest, not a complete
standalone application archive or a published release.

The fixture intentionally uses no Go third-party dependencies and no cgo. Choosing a
database driver or adding application dependencies can change both build and runtime costs.
Go's ability to build independently here does not remove Palmagent's existing whole-release
source-identity check; production artifact reuse needs a separate provenance and compatibility
design.
