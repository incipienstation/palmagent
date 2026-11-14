# Rust, Go and TypeScript: bounded build experiment

Go reduced feedback time in this small provider-adapter experiment, but the larger observed
delay in Palmagent was its release build and whole-release identity coupling. These results
support keeping Go as a candidate for a future native application layer; they do not justify
adding a Go production service or replacing the existing TypeScript server yet.

The experiment adds no production runtime, dependency, database migration or deployment.
Its Go and Rust ports are experimental, with explicitly recorded compatibility gaps.

## Evidence and reproduction

- Product source snapshot: `56760e0` on `develop`.
- [Reproducible runner and measurement definitions](../../../scripts/experiments/runtime-languages/README.md).
- [Parser build, parity and IPC samples](catalog-results.json).
- [Existing native workspace and packaging samples](native-results.json).
- The real TypeScript oracle is
  `apps/server/src/modules/agents/adapters/outbound/model-catalog.ts`, with its shared types.
  Input hashes are recorded in the reports.

Measurements used Linux ARM64, four logical CPUs, Node 24.21.0, Rust 1.94.0 and Go 1.27.4.
Compiler parallelism was capped at two; servers used their runtime defaults. The host was
shared, not an otherwise idle dedicated benchmark machine. The parser run's sampled
one-minute load averages were approximately 3.84–4.41. Treat the results as local evidence,
not language-wide speed ratios or capacity forecasts.

The parser has four rotated rounds per warm scenario. The native measurements have three
rounds, recorded in a separate serial run with unchanged native inputs and procedure.
Cold measurements have one sample each. Dependency downloads and toolchain installation
were excluded. Cold means fresh experiment build directories/caches, not flushed operating
system caches or a cleared global Zig cache. A cold Go cache compiles standard-library
packages; Rust's installed sysroot already contains compiled standard-library code.

## Small adapter build and feedback

The workload is the existing model-catalog projection: filter hidden models, normalize
strings, deduplicate choices, select default effort choices and bound model/effort arrays.
Go and Rust implement that projection, while TypeScript uses a copied source function.
The socket wrapper is a synthetic NDJSON server, not Palmagent's production HTTP server.

Seconds below are medians, except the single cold sample. TypeScript includes a strict
typecheck of the isolated projection/types and an esbuild bundle; it does not include the
whole-server typecheck. No persistent compiler/watch process is used.

| Build scenario | TypeScript | Go | Rust dev | Rust release, ThinLTO |
| --- | ---: | ---: | ---: | ---: |
| Cold build | 0.537 | 9.610 | 8.440 | 12.054 |
| No-change build | 0.506 | 0.067 | 0.064 | 0.065 |
| Logic edit: string limit 160 → 159, alternating | 0.480 | 0.317 | 0.467 | 4.504 |
| Shared contract value edit: protocol 1 → 2, alternating | 0.483 | 0.292 | 0.492 | 4.551 |
| Logic edit: build plus parity suite | 0.619 | 0.455 | 0.646 | 4.581 |

The protocol edit changes an exported constant in a separate module/package/crate. It does
not measure a schema-shape migration, regeneration across a full application, or an entire
provider integration.

Go saved about 0.16–0.19 seconds of feedback per sampled edit relative to the isolated
TypeScript and Rust development paths. Its advantage over an optimized Rust rebuild was
larger. These are different development/distribution profiles; the Rust development result
must not be substituted for the release runtime result.

Twelve Go-only warm builds left the already-built Rust executable's bytes and modification
time unchanged. That demonstrates independent compilation in the fixture. It does not prove
that today's Palmagent package/activation identity contract permits reusing an old binary.

## Existing Palmagent native builds

This is the existing workspace and packaging script, rather than the small adapter ports.
The packaging path selected `linux-arm64`, built both native binaries with the existing
musl/C-toolchain/LLD/ThinLTO settings, and produced their actual native manifest.
It did not build a complete standalone archive, publish, install or activate a release.

| Scenario | Native development build | One-platform native package build |
| --- | ---: | ---: |
| Cold | 45.024 s | 103.562 s |
| No change, median | 0.116 s | 0.272 s |
| Application error-message edit, median | 2.182 s | 23.551 s |
| Empty commit: release identity change only, median | 0.118 s | 33.985 s |

The package edit samples ranged from 23.356 to 23.584 seconds. Identity-only samples ranged
from 33.959 to 34.107 seconds. Logs confirm that the application edit rebuilt
`palmagent-runtime`, while an identity-only change rebuilt both `palmagent-runtime` and
`palmagentd`. Dependency downloads were outside the timed commands.

The package script supplies the repository HEAD as `PALMAGENT_SOURCE_COMMIT`; both binaries
embed it and declare that environment variable as a rebuild input. The development command
uses the development fallback instead. Thus an unrelated commit can require new native
release binaries even if their Rust source has not changed. Adding a Go component would
not remove this requirement.

These measurements do not compare an equivalent full Go application against Palmagent.
Do not compare the small Go port's 0.317-second edit against the whole native application's
23.551-second release rebuild as a language speedup. The native dev and packaging paths also
use different targets/toolchain settings; the difference is not an isolated LTO measurement.

## Runtime observations

Each sample uses an eight-model response, 1,000 warm-up requests and 1,000 measured requests.
The table reports medians of four rounds at concurrency one. All candidates buffer a full
serialized response before writing. Latency includes local socket transport and excludes
client JSON decoding. Throughput includes client validation and can be driver-limited.

| Metric | TypeScript/Node | Go | Rust dev | Rust release |
| --- | ---: | ---: | ---: | ---: |
| Process start to ready | 34.66 ms | 2.26 ms | 1.23 ms | 1.51 ms |
| Request p50 | 0.074 ms | 0.155 ms | 0.382 ms | 0.053 ms |
| Request p95 | 0.150 ms | 0.244 ms | 0.475 ms | 0.088 ms |
| Warm server RSS | 58.2 MiB | 9.0 MiB | 2.2 MiB | 1.9 MiB |

Concurrency-four samples, CPU accounting, high-water memory and driver resource use are in
the raw report. OS CPU accounting has coarse tick resolution; the driver peak RSS is
cumulative across the run. Neither a single server's RSS nor its latency is a whole-product
resource or performance estimate. The ports use different JSON libraries, string allocation
strategies and concurrency models. Default Go runtime parallelism and Rust thread-per-client
handling are not isolated compiler comparisons.

Adding Go alongside the existing Node server would retain Node's memory use and add another
process. The fixture's smaller Go RSS is not a demonstrated product memory saving.

This projection is already behind a five-minute model-catalog cache in the application.
The measured request loop deliberately stresses it; a real catalog refresh is not a hot
per-message path. Its faster native execution alone is a weak reason to migrate this feature.

## Compatibility and decision

The main corpus has 137 synthetic fixtures. After every cold/unchanged/edited/restored
build, it also checks malformed JSON followed by a valid request on the same connection.
Each of the four variants passed 1,946 checks: 7,784 total. This includes UTF-16 length
limits and truncation through an emoji surrogate pair.

Separate adversarial probes found two gaps in both native ports:

| Input | Existing TypeScript | Go fixture | Rust fixture |
| --- | --- | --- | --- |
| Escaped lone surrogate in a model name | Preserves the code unit | Replaces it | Rejects the JSON |
| Overflowing numeric value in unused metadata | Parses and ignores that metadata | Rejects the JSON | Rejects the JSON |
| Duplicate object key | Last value wins | Matches | Matches |

Those gaps prevent claiming full parser compatibility or production migration readiness.
The valid-input timing comparison remains useful, but adopting either port would require
resolving the decoder behavior or explicitly changing and verifying the accepted input
contract. None of those production decisions is made by this experiment.

The recommended sequence is:

1. Keep ordinary local Rust feedback on the development profile and the affected scope;
   reserve multi-target optimized packaging for distribution checks.
2. Design native artifact reuse around explicit component identity, hashes and protocol
   compatibility. Preserve the current provenance/activation checks while separating
   whole-release identity from a component's source identity. This needs coordinated build,
   manifest, health and activation changes; changing a cache key alone is insufficient.
3. Reconsider Go for a bounded application area if actual recurring development wait still
   warrants it, or if replacing the Node runtime has an independently measured benefit.
   Retain one state owner and a stable process protocol. Resolve parity gaps and measure
   the complete component, including persistence, recovery and all participating processes,
   before a production migration.

No Go production dependency, server rewrite, durability change or independent-component
release contract has been introduced.
