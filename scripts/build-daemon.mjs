// Build every supported native package artifact; consumers never need a Rust toolchain.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (program, args) => execFileSync(program, args, { cwd: root, encoding: 'utf8' }).trim();
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const sourceCommit = run('git', ['rev-parse', 'HEAD']);
const sysroot = run('rustc', ['--print', 'sysroot']);
const host = run('rustc', ['-vV']).match(/^host: (.+)$/m)?.[1];
if (!host) throw new Error('Cannot identify the Rust host toolchain');
const linker = join(sysroot, 'lib', 'rustlib', host, 'bin', process.platform === 'win32' ? 'rust-lld.exe' : 'rust-lld');
const targets = { 'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl' };
const output = join(root, 'build', 'daemon');
const artifacts = {};
for (const [platform, target] of Object.entries(targets)) {
  execFileSync('cargo', ['build', '--release', '--locked', '--package', 'palmagentd', '--target', target], {
    cwd: root, stdio: 'inherit', env: { ...process.env,
      PALMAGENT_PRODUCT_VERSION: version, PALMAGENT_SOURCE_COMMIT: sourceCommit,
      CARGO_TARGET_DIR: join(root, 'target'),
      [`CARGO_TARGET_${target.replaceAll('-', '_').toUpperCase()}_LINKER`]: linker,
      // Panic strings and source locations in public native artifacts must not embed builder paths.
      RUSTFLAGS: `--remap-path-prefix=${root}=. --remap-path-prefix=${homedir()}=.`,
    },
  });
  const directory = join(output, platform);
  mkdirSync(directory, { recursive: true });
  const binary = join(directory, 'palmagentd');
  copyFileSync(join(root, 'target', target, 'release', 'palmagentd'), binary);
  chmodSync(binary, 0o755);
  artifacts[platform] = createHash('sha256').update(readFileSync(binary)).digest('hex');
}
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ protocol: 1, version, sourceCommit, artifacts }, null, 2) + '\n');
