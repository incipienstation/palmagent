---
name: staging-deploy
description: Deploy an approved exact Palmagent npm version or CI package to the privately bound staging installation, verify runtime identity, or roll back from a retained deployment receipt.
---

# Staging deploy

Read [the staging runbook](../../../docs/STAGING.md) for commands and recovery. Use the repository
`scripts/deploy-staging.mjs` command; do not replace frontend files by hand or use a moving npm
dist-tag. The private binding defines staging. A DNS name, branch, or old deployment note does
not establish an environment's role. Never commit host values or receipts.

Resolve the authorized exact version/commit or successful CI tarball and checksum. Check whether
the installed package has manual overlays missing from the candidate. Review database
compatibility and runner changes before activation, then run the command's dry-run. Present the
concrete target and impact if deployment authorization is still missing; existing explicit
authorization for that same action remains valid. A version/tag/merge approval alone does not
authorize host deployment.

Apply the validated package through the command. Report the receipt, source commit, archive
checksum, and runtime/PWA verification. A failed command is not success even if npm completed.
Retain failure evidence; inspect locks and current state before retrying. Roll back only after
the operator has accepted database compatibility; package rollback does not restore a database.

Version selection, npm publication, and production deployment follow
[the release runbook](../../../docs/RELEASING.md) and remain separate actions.
