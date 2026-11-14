import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { globSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// These integration files execute binaries produced by daemon:check. Keep them
// on that runner; all other contracts can start without waiting for Rust.
const native = new Set([
  'tests/integration/native-routine-host.test.ts',
  'tests/integration/native-script-runtime.test.ts',
  'tests/integration/routine-host.test.ts',
]);
export function contractFiles(group, cwd) {
  assert(['native', 'node'].includes(group), 'Expected native or node contract group');
  const files = [...globSync(['tests/**/*.test.ts', 'tests/**/*.test.mjs'], { cwd })].sort();
  for (const path of native) assert(files.includes(path), `Missing native contract: ${path}`);
  const selected = files.filter(path => native.has(path) === (group === 'native'));
  assert(selected.length > 0, 'Contract group must not be empty');
  return selected;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    assert(process.argv.length === 3, 'Usage: node scripts/run-contracts.mjs <native|node>');
    const files = contractFiles(process.argv[2], cwd);
    const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...files], { cwd, stdio: 'inherit' });
    const stop = signal => child.kill(signal);
    const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
    child.on('close', (code, signal) => {
      process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
      process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
    });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
