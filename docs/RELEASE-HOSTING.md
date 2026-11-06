# Release hosting setup

The implementation uses a Cloudflare Worker for `releases.palmagent.dev` and the
`palmagent.dev/install.sh` route, plus a private R2 bucket for signed channel documents.
Versioned archives and manifests remain immutable GitHub Release assets. The site does
not need a rebuild for each product release.

## Configure before enabling publication

1. Authenticate the project Cloudflare account with permission to manage the project's
   Worker, routes and R2 bucket. Create `palmagent-release-index`. Inspect existing route
   ownership before applying `deploy/releases/wrangler.jsonc`.
2. Generate an Ed25519 signing key in approved secret storage. Add only its PEM public key
   under a stable key ID in `packages/shared/src/release-trust.json`. Store the private PEM
   as the GitHub environment secret `RELEASE_SIGNING_KEY` and the ID as environment variable
   `RELEASE_SIGNING_KEY_ID`. Never commit a private key or paste one into a conversation.
3. Create `standalone-preview` restricted to `develop`, without a reviewer requirement.
   Retain the protected `npm-latest` environment restricted to `main`, including its Stable
   reviewer gate and npm Trusted Publisher binding. Configure the same signing pair in
   both environments. Old `npm-next` history may remain; new Preview never uses it.
4. Run `node scripts/render-installer.mjs`, then deploy the Worker using the reviewed
   Wrangler configuration and a pinned Wrangler version. Set `REPOSITORY_ID` to the
   repository's verified numeric ID. The Worker accepts only GitHub OIDC for the exact
   repository, workflow, branch, environment and release-origin audience. No permanent
   storage upload token is needed in Actions.
5. Verify HTTPS `/health`, `/install.sh`, and that an unauthenticated channel write is
   rejected. Empty channels return 404. Set `STANDALONE_PUBLISH_ENABLED=true` only after
   the trusted keys, domain, bucket and OIDC policy are ready. Stable also requires
   `NPM_PUBLISH_ENABLED=true`.

The publisher performs an authenticated signed preflight before creating a tag. An absent
key, bad route, missing bucket or wrong OIDC policy therefore fails before public release
mutation. The repository contains only the public trust key; the private key must be provisioned externally. source implementation,
hosting deployment, channel publication and host installation are separate milestones.

## Candidate and recovery

Candidate automation builds common JS/PWA once, native x64/arm64 bundles on glibc 2.35,
and source checks in independent jobs. Every selected check must pass before the immutable
candidate is uploaded. Preview contains no npm archive. Stable adds an npm archive using
the same common build and verified native binaries.

`npm-publish.yml` retains its filename for existing automation and Trusted Publisher
configuration, but publishes both distributions. Preview uses `standalone-preview`; Stable
uses the single existing `npm-latest` approval before tags, npm publication or public
Release. A retry selects the original candidate run and verifies all hashes. It fills only
missing draft assets, never replaces existing bytes. After public assets are verified, the
Worker advances the channel by conditional write; a concurrent publisher gets HTTP 412.
Readback must match the exact signed bytes before success is reported.

A public release whose channel activation failed remains retryable from the original
candidate. A newer channel is never overwritten by an older run. For a bad installed
release, publish a higher corrected version; no automatic downgrade or database rollback
is performed. Measure queue, build, publication and activation timings separately before
claiming a speed improvement over the former npm path.
