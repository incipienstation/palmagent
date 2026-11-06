#!/usr/bin/env node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { extractReleaseArchive, sha256File } from '../apps/server/src/platform/filesystem/release-artifact.ts';
import { standaloneTargets } from './lib/standalone-release.mjs';
const directory = resolve(process.argv[2] ?? 'build/release'), pkg = resolve(process.argv[3] ?? 'build/pkg');
const info = JSON.parse(readFileSync(join(pkg, 'build-info.json'), 'utf8'));
if (info.version.includes('-') || info.dirty !== false) throw new Error('Only a clean Stable candidate can produce an npm archive');
const scratch = mkdtempSync(join(tmpdir(), 'palmagent-stable-'));
try {
  let combined;
  for (const target of standaloneTargets) {
    const report = JSON.parse(readFileSync(join(directory, `${target}.json`), 'utf8'));
    if (report.version !== info.version || report.sourceCommit !== info.sourceCommit || report.target !== target) throw new Error('Platform report source differs');
    const archive = join(directory, report.artifact.filename), destination = join(scratch, target);
    if (sha256File(archive) !== report.artifact.sha256) throw new Error('Standalone archive differs');
    mkdirSync(destination);
    extractReleaseArchive(archive, destination, report.artifact.size, report.artifact.unpackedSize);
    const daemon = join(destination, 'palmagent/app/daemon'), manifest = JSON.parse(readFileSync(join(daemon, 'manifest.json'), 'utf8'));
    if (manifest.version !== info.version || manifest.sourceCommit !== info.sourceCommit) throw new Error('Native source differs');
    const platform = target.replace('-glibc', '');
    for (const [name, digest] of [['palmagentd', manifest.artifacts[platform]], ['palmagent-runtime', manifest.applicationArtifacts[platform]]])
      if (sha256File(join(daemon, platform, name)) !== digest) throw new Error('Native archive checksum differs');
    cpSync(join(daemon, platform), join(pkg, 'daemon', platform), { recursive: true });
    combined ??= { ...manifest, artifacts: {}, applicationArtifacts: {} };
    combined.artifacts[platform] = manifest.artifacts[platform];
    combined.applicationArtifacts[platform] = manifest.applicationArtifacts[platform];
  }
  writeFileSync(join(pkg, 'daemon/manifest.json'), JSON.stringify(combined, null, 2) + '\n');
} finally { rmSync(scratch, { recursive: true, force: true }); }
