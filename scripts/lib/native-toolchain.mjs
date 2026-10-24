// SQLite's bundled C source needs target headers as well as Rust's musl libraries.
// Pin and verify the compiler so both package architectures use the same toolchain.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const version = '0.15.2';
const hashes = {
  arm64: '958ed7d1e00d0ea76590d27666efbf7a932281b3d7ba0c6b01b0ff26498f667f',
  x64: '02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239',
};
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export async function sqliteToolchain(root) {
  if (process.platform !== 'linux' || !hashes[process.arch]) throw new Error('Native package assembly requires a Linux x64 or arm64 builder.');
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const cache = join(homedir(), '.cache', 'palmagent-build', `zig-${version}-${arch}`);
  const executable = join(cache, 'zig'), receipt = join(cache, '.verified');
  if (!existsSync(executable) || !existsSync(receipt) || readFileSync(receipt, 'utf8') !== hashes[process.arch]) {
    const temporary = mkdtempSync(join(tmpdir(), 'palmagent-zig-'));
    try {
      const response = await fetch(`https://ziglang.org/download/${version}/zig-${arch}-linux-${version}.tar.xz`, { signal: AbortSignal.timeout(120_000), redirect: 'error' });
      if (!response.ok) throw new Error('Cannot download the pinned native compiler.');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 64 * 1024 * 1024) throw new Error('Native compiler archive exceeds its size limit.');
        chunks.push(chunk);
      }
      const archive = Buffer.concat(chunks);
      if (createHash('sha256').update(archive).digest('hex') !== hashes[process.arch]) throw new Error('Native compiler checksum mismatch.');
      writeFileSync(join(temporary, 'zig.tar.xz'), archive);
      mkdirSync(join(temporary, 'unpacked'));
      execFileSync('tar', ['-xJf', join(temporary, 'zig.tar.xz'), '-C', join(temporary, 'unpacked'), '--strip-components=1']);
      writeFileSync(join(temporary, 'unpacked', '.verified'), hashes[process.arch]);
      mkdirSync(join(homedir(), '.cache', 'palmagent-build'), { recursive: true });
      if (existsSync(cache)) throw new Error('Native compiler cache is incomplete; inspect it before rebuilding.');
      renameSync(join(temporary, 'unpacked'), cache);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  // cc-rs fingerprints the compiler path. A random wrapper directory would rebuild
  // bundled SQLite on every otherwise-cached native build.
  const directory = join(cache, 'wrappers');
  mkdirSync(directory, { recursive: true });
  for (const target of ['x86_64', 'aarch64']) {
    const wrapper = join(directory, target);
    const content = `#!/bin/sh\nexec ${quote(executable)} cc -target ${target}-linux-musl "$@"\n`;
    if (!existsSync(wrapper) || readFileSync(wrapper, "utf8") !== content) writeFileSync(wrapper, content, { mode: 0o700 });
  }
  return {
    environment(target) {
      const key = target.replaceAll('-', '_');
      return { [`CC_${key}`]: join(directory, target.split('-')[0]), CRATE_CC_NO_DEFAULTS: '1',
        // The wrapper selects Zig's target spelling; cc-rs must not add Rust's triple.
        [`CFLAGS_${key}`]: `-O3 -fPIC -ffunction-sections -fdata-sections -ffile-prefix-map=${root}=. -ffile-prefix-map=${homedir()}=.` };
    },
    close() { /* Verified compiler and stable wrappers are reusable build cache. */ },
  };
}
