import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localScope, requireVerificationNode, runVerification, verificationSteps } from './lib/local-verification.mjs';

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let base = 'origin/develop', planOnly = false, timeoutMs;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--plan') planOnly = true;
  else if (args[i] === '--base' && args[i + 1] && !args[i + 1].startsWith('-')) base = args[++i];
  else if (args[i] === '--timeout-seconds' && /^\d+$/.test(args[i + 1] ?? '')
    && Number(args[i + 1]) > 0 && Number(args[i + 1]) <= 86400) timeoutMs = Number(args[++i]) * 1000;
  else {
    console.error('Usage: node scripts/verify-local.mjs [--plan] [--base remote/branch|commit] [--timeout-seconds 1..86400]');
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
const steps = verificationSteps(result);
console.log(`Checks: ${steps.map(step => step.id).join(', ')}`);
if (!planOnly) {
  const controller = new AbortController();
  const interrupt = () => controller.abort('SIGINT');
  const terminate = () => controller.abort('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try { process.exitCode = await runVerification(steps, { cwd, signal: controller.signal, timeoutMs }); }
  finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
}
