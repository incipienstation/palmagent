---
name: verify
description: Third stage of Palmagent's plan → start → verify → ship loop. Run repository checks appropriate to the change scope before delivery. Use after implementation and before shipping.
---

# Verify

Run the metadata checks for every change, from the repository root:

```bash
pnpm plugins:check
pnpm release:check
git diff --check
```

Select additional checks with the existing [CI classifier](../../../scripts/lib/ci-scope.mjs).
Use the complete task diff from the merge base with the current target branch, including staged,
unstaged, and relevant untracked files, and both sides of renames. Never classify only the last
commit. This read-only example targets `develop`; substitute the actual PR base when different:

```sh
node --input-type=module <<'JS'
import { execFileSync } from 'node:child_process';
import { classifyChanges } from './scripts/lib/ci-scope.mjs';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let paths;
try {
  const base = git('merge-base', 'origin/develop', 'HEAD').trim();
  paths = [...new Set([
    ...git('diff', '--name-only', '--no-renames', '-z', base, 'HEAD', '--').split('\0'),
    ...git('diff', '--cached', '--name-only', '--no-renames', '-z', '--').split('\0'),
    ...git('diff', '--name-only', '--no-renames', '-z', '--').split('\0'),
    ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0'),
  ].filter(Boolean))];
} catch { /* Missing history selects every lane. */ }
console.log(JSON.stringify(classifyChanges(paths)));
JS
```

Fetch the target branch before classification; if its current state or scope cannot be established,
use the full gate. Follow the selected lanes in [ci.yml](../../../.github/workflows/ci.yml):

| Scope flag | Local checks, in addition to metadata |
| --- | --- |
| All false | No runtime checks for documentation and skill-only changes |
| `code` | `pnpm typecheck` and `pnpm pkg:check` |
| `server` | `pnpm server:contracts` and `pnpm server:smoke` |
| `web` | `pnpm web:verify` |
| `package` | The CI web job's packed-candidate checks, including its denylist requirements; build the PWA first and reuse that build |

When every flag is true, run `pnpm verify` plus the selected packed-candidate checks. Dependencies,
tooling, workflows, unknown paths, and unavailable history retain this full gate. Release candidates
retain full source and packed-install verification under the
[CI and candidate policy](../release/references/automation.md#candidate-automation).

Add focused behavioral or browser checks when the change needs evidence beyond the selected lanes.
Reuse successful checks for unchanged inputs and environment; repeat affected checks after fixes,
new changes, or invalidated evidence. Required CI still runs on the current PR head. Keep verbose
logs outside the repository and report outcomes; inspect bounded failure excerpts when needed.
Notes:

- If an operator plugin skill is out of sync, run `node scripts/sync-skills.mjs` (without `--check`)
  to regenerate, then re-run. For repository-maintenance skills, repair the links described in
  [AGENTS.md](../../../AGENTS.md#repository-skill-single-source).
- If the **leak guard** flags a match it prints `file:line` only (values are redacted on purpose).
  Open those lines locally and remove or generalize the content.

Green → chain into [ship](../ship/SKILL.md). Red → fix and re-run; never proceed red.
