# Release hosting setup

GitHub Pages serves `https://releases.palmagent.dev`: the installation script and signed
Preview/Stable channel documents. Versioned archives and manifests remain immutable GitHub
Release assets. GitHub Actions builds and publishes both; no Worker, R2 bucket, or separate
hosting account is needed. Cloudflare can remain the domain's DNS provider.

The official bootstrap entry point remains `https://palmagent.dev/install.sh`. Configure
an exact `/install.sh` route on the main website's HTTPS server to redirect temporarily
to `https://releases.palmagent.dev/install.sh`. Keep the Pages URL available for existing
clients. This route needs no website rebuild for each release; signed channel discovery
continues to use `releases.palmagent.dev`. Verify the public redirect and compare the final
script bytes with Pages separately from the Pages publication checks.

## Configure before enabling publication

1. Enable Pages for this repository with **GitHub Actions** as its publishing source. Set
   its custom domain to `releases.palmagent.dev` before changing DNS. At the DNS provider,
   create a `CNAME` for `releases` pointing to `incipienstation.github.io` (no repository
   path). Use DNS-only mode if the provider offers a proxy. Wait for the DNS check and
   certificate, then enable **Enforce HTTPS** in Pages settings. The main website's DNS
   records do not need to change. See GitHub's
   [custom-domain instructions](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).
2. Generate an Ed25519 signing key in approved secret storage. Add only its PEM public key
   under a stable key ID in `packages/shared/src/release-trust.json`. Store the private PEM
   as the GitHub environment secret `RELEASE_SIGNING_KEY` and the ID as environment variable
   `RELEASE_SIGNING_KEY_ID`. Never commit or paste a private key into a conversation.
3. Create `standalone-preview` restricted to `develop`, without a reviewer requirement.
   Retain the protected `npm-latest` environment restricted to `main`, including its Stable
   reviewer gate and npm Trusted Publisher binding. Configure the signing pair in both.
   New Preview publication does not use the historical `npm-next` environment.
4. Run `release-pages.yml` on `develop`. It publishes the installer and health document,
   preserving both signed channels if the `release-channels` branch already exists. An
   unpublished channel returns 404. The deployment must verify its exact public files.
5. Set `STANDALONE_PUBLISH_ENABLED=true` only after the Pages deployment and HTTPS checks
   pass. Stable additionally requires `NPM_PUBLISH_ENABLED=true`.

The Pages jobs use their existing release environments and GitHub's short-lived token/OIDC;
there is no extra Stable approval or permanent hosting upload token. The publication job
checks Pages configuration, the deployed trust keys, the source client's trust keys, and
channel history before it creates a tag. Repository configuration, site deployment,
channel publication and host installation are separate milestones.

## Publication and recovery

Candidate automation builds common JS/PWA once, native x64/arm64 bundles on glibc 2.35,
and source checks in independent jobs. Every selected check must pass before the immutable
candidate is uploaded. Preview contains no npm archive. Stable adds an npm archive using
the same common build and verified native binaries.

`npm-publish.yml` retains its filename for existing automation and Trusted Publisher
configuration. Its single `npm-latest` approval precedes Stable tags, npm publication and
public Release creation. A retry selects the original candidate run and verifies all
hashes. It fills only missing draft assets and never replaces existing bytes.

After public assets are verified, the publisher commits the signed channel document to
the `release-channels` data branch. This branch contains only `preview.json` and/or
`stable.json`. Its Git history is the durable publication journal; do not delete, reset,
force-push or manually edit it. A non-fast-forward ref update fails instead of overwriting
a concurrent publisher. An unchanged version must retain the same manifest hash and exact
signed channel bytes. A newer version can never be replaced by an older release.

Both channels and the installer form one Pages artifact. Preview, Stable and manual Pages
recovery share a concurrency group for the entire staging/deployment/readback cycle, so
deploying one channel preserves the other. The journal head is checked before deployment.
Only the final HTTPS readback of the installer and both channel files establishes success;
a public Release, journal commit or successful deployment action alone does not.

If Pages activation fails after the release becomes public, rerun publication with the
original candidate or run `release-pages.yml` to deploy the already-staged journal. The
recovery workflow has no signing key and cannot allocate a release or change channel
history. It can deploy previously approved Stable channel bytes without another approval.
Pages/CDN propagation can delay discovery; readback waits for the exact artifact bytes
within a bounded timeout. Repeated mismatch is a failure, not a successful publication.

For a bad installed release, publish a higher corrected version. There is no automatic
downgrade or database rollback. Measure queue, build, publication and Pages activation
separately before claiming a speed improvement over the former npm path.
