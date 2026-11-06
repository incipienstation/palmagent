import { spawnSync } from 'node:child_process';

const levels = ['low', 'moderate', 'high', 'critical'];

export function auditExitCode(result, level) {
  if (!levels.includes(level)) throw new Error('Unknown audit threshold');
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    throw new Error('Dependency scanner did not complete successfully');
  }
  const report = JSON.parse(result.stdout);
  const counts = report.metadata?.vulnerabilities;
  if (report.error || !counts || !report.advisories || Array.isArray(report.advisories)
    || typeof report.advisories !== 'object'
    || levels.some(key => !Number.isSafeInteger(counts[key]) || counts[key] < 0)) {
    throw new Error('Dependency scanner returned an invalid report');
  }
  const hasFindings = levels.some(key => counts[key] > 0);
  if (result.status !== Number(hasFindings)
    || (hasFindings && Object.keys(report.advisories).length === 0)) {
    throw new Error('Dependency scanner status or advisory details are inconsistent');
  }
  return Number(levels.slice(levels.indexOf(level)).some(key => counts[key] > 0));
}

if (import.meta.main) {
  const [scope, level, ...extra] = process.argv.slice(2);
  if (!['production', 'all'].includes(scope) || !levels.includes(level) || extra.length) {
    console.error('Usage: node scripts/audit-javascript.mjs <production|all> <low|moderate|high|critical>');
    process.exitCode = 1;
  } else {
    // pnpm filters advisory details at --audit-level. Always collect all findings,
    // then apply the gate without altering the JSON saved by CI.
    const result = spawnSync('pnpm', ['audit', '--json', '--audit-level', 'low',
      ...(scope === 'production' ? ['--prod'] : [])], {
      encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
    });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    try { process.exitCode = auditExitCode(result, level); }
    catch (error) {
      console.error(`Security audit failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
