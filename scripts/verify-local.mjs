import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localScope, runVerification, verificationSteps } from './lib/local-verification.mjs';

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let base = 'origin/develop', planOnly = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--plan') planOnly = true;
  else if (args[i] === '--base' && args[i + 1] && !args[i + 1].startsWith('-')) base = args[++i];
  else {
    console.error('Usage: node scripts/verify-local.mjs [--plan] [--base remote/branch|commit]');
    process.exit(2);
  }
}
const result = localScope(cwd, base);
if (result.reason) console.log(result.reason);
console.log(`Scope: ${JSON.stringify(result.scope)}`);
const steps = verificationSteps(result);
console.log(`Checks: ${steps.map(step => step.id).join(', ')}`);
if (!planOnly) process.exitCode = runVerification(steps, { cwd });
