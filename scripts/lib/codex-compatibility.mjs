import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const stableVersion = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
  && value.split('.').every(part => Number.isSafeInteger(Number(part)));
export function compareVersions(a, b) {
  if (![a, b].every(stableVersion)) throw new Error('Expected exact stable CLI versions');
  const right = b.split('.').map(Number);
  return a.split('.').map(Number).reduce((result, n, i) => result || n - right[i], 0);
}
export function nextPatch(version) {
  if (!stableVersion(version)) throw new Error('Invalid CLI version');
  const parts = version.split('.').map(Number);
  parts[2]++;
  const result = parts.join('.');
  if (!stableVersion(result)) throw new Error('CLI version overflow');
  return result;
}
export function lastSupported(lane) {
  if (!stableVersion(lane.exclusiveMaximum) || !stableVersion(lane.minimum)
    || lane.range !== '>=' + lane.minimum + ' <' + lane.exclusiveMaximum) throw new Error('Inconsistent compatibility metadata');
  const parts = lane.exclusiveMaximum.split('.').map(Number);
  if (!parts[2]) throw new Error('Compatibility ceiling must follow the last verified patch');
  parts[2]--;
  return parts.join('.');
}
export function nextCandidate(metadata, baseline) {
  const latest = metadata['dist-tags']?.latest;
  if (!stableVersion(latest) || !Array.isArray(metadata.versions)) throw new Error('Malformed Codex registry metadata');
  return metadata.versions.filter(stableVersion)
    .filter(version => compareVersions(version, baseline) > 0 && compareVersions(version, latest) <= 0)
    .sort(compareVersions)[0] ?? null;
}
export function saveState(path, state) {
  const temp = path + '.' + process.pid + '.tmp';
  writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
}

// Only a completed compatibility failure can cross the paid boundary. Setup,
// downloads, baseline failures and exceptions propagate without invoking repair.
export async function gateVersion({ inspectBaseline, inspectCandidate, repair, verifyRepair, save }, state, allowRepair) {
  if (state.repairAttempts) return { status: 'held', reason: 'A repair was already attempted for this version' };
  const baseline = await inspectBaseline();
  const issues = await inspectCandidate(baseline);
  if (!Array.isArray(issues)) throw new Error('Invalid compatibility result');
  if (!issues.length) return { status: 'passed', mode: 'schema-contract' };
  state.issues = issues;
  await save();
  if (!allowRepair) return { status: 'held', reason: 'Compatibility failed; paid repair is disabled' };
  // Persist BEFORE spawning: a crash, timeout or service restart must not spend
  // again on the next scheduled run, even when the first result was lost.
  state.repairAttempts = 1;
  state.stage = 'repair-started';
  await save();
  await repair(issues);
  await verifyRepair();
  return { status: 'passed', mode: 'repaired-live' };
}

export const metadataFiles = [
  'packages/shared/src/agent-compatibility.json',
  'plugins/claude/agent-compatibility.json',
  'plugins/codex/plugins/palmagent/agent-compatibility.json',
  'docs/CODEX-COMPATIBILITY.md', 'docs/codex-compatibility-runs.json',
];
export function allowedChanges(paths, repaired = false) {
  return paths.length > 0 && paths.every(path => metadataFiles.includes(path)
    || repaired && ['apps/server/src/modules/agents/adapters/outbound/codex.ts', 'apps/server/src/modules/agents/adapters/outbound/codex-interactive.ts',
      'apps/server/tests/contracts/adapter-contracts.test.ts', 'scripts/lib/codex-protocol-contract.mjs'].includes(path));
}
export function updateCompatibility(cwd, version, receipt) {
  const path = join(cwd, metadataFiles[0]);
  const metadata = JSON.parse(readFileSync(path, 'utf8'));
  const baseline = lastSupported(metadata.codex);
  if (compareVersions(version, baseline) <= 0) throw new Error('Refusing non-increasing support update');
  metadata.codex.exclusiveMaximum = nextPatch(version);
  metadata.codex.range = '>=' + metadata.codex.minimum + ' <' + metadata.codex.exclusiveMaximum;
  writeFileSync(path, JSON.stringify(metadata, null, 2) + '\n');
  const document = join(cwd, 'docs/CODEX-COMPATIBILITY.md');
  const original = readFileSync(document, 'utf8');
  const start = original.indexOf('The declared Codex range is ');
  const end = original.indexOf('The shared metadata', start);
  if (start < 0 || end < 0) throw new Error('Compatibility document header was not recognized');
  writeFileSync(document, original.slice(0, start) + 'The declared Codex range is ' +
    String.fromCharCode(96) + metadata.codex.range + String.fromCharCode(96) + '.\n' + original.slice(end));
  const records = join(cwd, 'docs/codex-compatibility-runs.json');
  let entries;
  try { entries = JSON.parse(readFileSync(records, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }
  entries.push({ version, baseline, ...receipt });
  writeFileSync(records, JSON.stringify(entries, null, 2) + '\n');
}
