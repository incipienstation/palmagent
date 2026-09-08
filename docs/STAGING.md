# Staging package deployment

Staging is an explicitly bound installation, never a role inferred from a hostname. Keep the
binding, deployment receipts, package snapshots, logs, and database outside the source repository.
Run these commands as the installed service owner, using the Node/npm toolchain that owns its
global package prefix. The existing CLI handles privileged systemd/nginx operations.

## Bind an existing installation

After confirming the target is staging, supply the real host values privately:

```bash
pnpm staging:deploy bind \
  --data-dir '<absolute-state-directory>' \
  --npm-prefix '<absolute-npm-prefix>' \
  --domain '<staging-hostname>'
```

The command creates `~/.config/palmagent/staging.json` with mode 0600. It checks the service
owner, package installation, domain, data directory, and global npm prefix against `install.env`.
It refuses to replace an existing binding. `--config <private-file>` selects another binding.
Binding does not install a package or restart a service.

## Deploy an approved package

For a published prerelease, choose the exact version and commit from its reviewed release:

```bash
pnpm staging:deploy deploy --version '<exact-version>' --commit '<40-character-source-sha>' --dry-run
pnpm staging:deploy deploy --version '<exact-version>' --commit '<40-character-source-sha>'
```

`next` and `latest` are moving discovery channels, not deploy targets. The command downloads
the exact npm version, checks its embedded clean-source identity, and records the archive hash.
Stable candidates can also be accepted in staging before production promotion.

Before npm setup is complete, use the tarball from a successful `develop` push instead:

```bash
gh run view '<run-id>' --json headSha,headBranch,event,conclusion
gh run download '<run-id>' --name 'palmagent-candidate-<source-sha>' --dir '<private-artifact-directory>'
sha256sum '<private-artifact-directory>/palmagent-<version>.tgz'
pnpm staging:deploy deploy --artifact '<package.tgz>' --sha256 '<reviewed-sha256>' --commit '<source-sha>' --dry-run
pnpm staging:deploy deploy --artifact '<package.tgz>' --sha256 '<reviewed-sha256>' --commit '<source-sha>'
```

Confirm the run is a successful `push` to `develop` and its `headSha` matches the requested
commit. Candidate release assets may also be supplied this way. A locally computed checksum
pins downloaded bytes; it does not authenticate the producer. Verify the trusted workflow/run
before approving the checksum. Dirty local builds and packages without source identity cannot
be new deployment targets.

Dry-run downloads and validates into temporary storage. It performs no package installation,
service restart, or persistent deployment write. Before activation, review schema compatibility,
the data backup/restore plan, and any runner changes that could end active turns. A full package
replaces manual live overlays: include their intended source changes in the candidate first.

The apply command locks `<data-dir>/deployments`, snapshots the currently installed product
package (including manual product-file changes), writes a private receipt, installs the exact
tarball into the bound npm prefix, and invokes the newly installed CLI's `update` command.
It never uses `update --pull`. The CLI keeps an unchanged runner alive and restarts a changed
runner. npm installs declared runtime dependencies; the snapshot is a product-package rollback,
not a frozen snapshot of transitive dependencies or the operating system.

Success requires installed product-file hashes, local and public health, the running server's
embedded version/commit, and served PWA entry-file hashes to match. The result includes the
version, commit, SHA-256, and receipt path. `deployments/current.json` points to the latest
successful operation. CI success or an npm install exit code alone is not readiness evidence.

## Rollback and failures

After confirming the previous code can use the current database schema:

```bash
pnpm staging:deploy rollback --receipt '<deployment.json>' --database-compatible
```

Rollback checks the installation binding, current package hashes, and retained prior tarball's
checksum, then installs and activates that exact prior package and verifies health/PWA again.
Legacy snapshots without embedded source identity are allowed only as retained rollback inputs;
their product files and served PWA are checked, but their health endpoint cannot prove a source
commit. Both deployment and rollback leave database files untouched; starting either server
version may run migrations. The compatibility flag records an operator decision, not an
automated schema guarantee. Restore a database only through a separately approved recovery plan.

A failed operation retains its receipt and snapshots. It does not automatically downgrade code
after activation, restore data, delete previous releases, or conceal the failure. Rollback refuses
to overwrite a later deployment or manual overlay. If npm failed halfway through installation,
the installed files may not match either receipt: inspect the recorded phase and repair the
package from the retained tarball before attempting activation; do not bypass the drift check.

An existing lock blocks concurrent operations. If a process was interrupted, inspect
`deployments/.lock/owner.json`, prove that process has ended, and remove only that stale lock.
Interrupted operations can leave `prepared`, `installing`, or `activating` receipts; inspect the
actual installed files and services before recovery. No cleanup or database restore is automatic.
