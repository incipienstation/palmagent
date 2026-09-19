import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createWebHarness } from './web-harness.mjs';

const require = createRequire(import.meta.url);
let child;
let interrupted;
const interrupt = signal => { interrupted = signal; child?.kill(signal); };
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
const harness = await createWebHarness();
const webDir = fileURLToPath(new URL('..', import.meta.url));
const outputDir = join(webDir, 'test-results', harness.runId);
try {
  if (!interrupted) {
    child = spawn(process.execPath, [require.resolve('@playwright/test/cli'), 'test', ...process.argv.slice(2)], {
      cwd: webDir,
      env: { ...process.env, E2E_BASE_URL: harness.urls[0], E2E_STATEFUL_URL: harness.urls[1], E2E_OUTPUT_DIR: outputDir },
      stdio: 'inherit',
    });
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143)));
    });
  }
} finally {
  await harness.close();
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  if (interrupted) process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
  if (process.exitCode === 0) await rm(outputDir, { recursive: true, force: true });
}
