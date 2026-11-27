import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localScope, requireVerificationNode, runVerification, verificationSteps } from './lib/local-verification.mjs';

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let base = 'origin/develop', planOnly = false, extended = false, timeoutMs, resume;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--plan') planOnly = true;
  else if (args[i] === '--extended') extended = true;
  else if (args[i] === '--resume' && args[i + 1] && !args[i + 1].startsWith('-')) resume = args[++i];
  else if (args[i] === '--base' && args[i + 1] && !args[i + 1].startsWith('-')) base = args[++i];
  else if (args[i] === '--timeout-seconds' && /^\d+$/.test(args[i + 1] ?? '')
    && Number(args[i + 1]) > 0 && Number(args[i + 1]) <= 86400) timeoutMs = Number(args[++i]) * 1000;
  else {
    console.error('Usage: node scripts/verify-local.mjs [--plan] [--extended] [--base remote/branch|commit] [--timeout-seconds 1..86400] [--resume log-directory]');
    process.exit(2);
  }
}
if (!planOnly) {
  try { requireVerificationNode(cwd); }
  catch (error) { console.error(error.message); process.exit(1); }
}
const result = localScope(cwd, base);
if (result.reason) console.log(result.reason);
console.log(`Scope: ${JSON.stringify(result.scope)}`);
// Resume receipts belong to the extended suite. Missing history keeps the full fallback.
extended = extended || Boolean(resume) || !result.paths;
console.log(`Local mode: ${extended ? 'extended' : 'focused'}`);
const steps = verificationSteps(result, { extended });
console.log(`Checks: ${steps.map(step => step.id).join(', ')}`);
if (!extended && result.paths.length) {
  console.log('Exercise the changed behavior with a focused test or direct inspection and record the result in the PR.');
  if (result.paths.some(path => path.startsWith('apps/web/src/'))) {
    console.log('Web UI: inspect the affected interaction or build the PWA and run the relevant browser spec.');
  }
}
if (!planOnly) {
  const controller = new AbortController();
  const interrupt = () => controller.abort('SIGINT');
  const terminate = () => controller.abort('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try { process.exitCode = await runVerification(steps, { cwd, signal: controller.signal, timeoutMs, context: extended ? result : undefined, resume }); }
  finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
}
