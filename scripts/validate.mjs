#!/usr/bin/env node
// Static validation for Palmagent's plugin surfaces and public repository content.
//
// LEAK-GUARD OUTPUT POLICY: on any leak match we print `<file>:<line>` ONLY —
// never the matched token or the line text. Echoing the value into CI logs would
// itself be a leak. The committed generic patterns encode no secrets; the
// context/PII denylist lives in the `LEAK_DENYLIST` Actions secret (never in the
// repo). GitHub's secret masking is a backstop, not the primary defense.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const fail = (m) => errors.push(m);

const readJSON = (rel) => {
  try {
    return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
  } catch (e) {
    fail(`JSON parse failed: ${rel} (${e.message})`);
    return null;
  }
};
const dig = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
const need = (obj, path, where) => {
  const v = dig(obj, path);
  if (v === undefined || v === null || v === '') fail(`${where}: missing required field \`${path}\``);
  return v;
};

// ---- 1 + 2. manifests: parse + required fields ----------------------------
const cm = readJSON('.claude-plugin/marketplace.json');
if (cm) {
  need(cm, 'name', 'claude marketplace');
  if (!Array.isArray(cm.plugins) || cm.plugins.length === 0) {
    fail('claude marketplace: `plugins` must be a non-empty array');
  } else for (const p of cm.plugins) {
    need(p, 'name', 'claude marketplace entry');
    need(p, 'source', 'claude marketplace entry');
  }
}
const cp = readJSON('plugins/claude/.claude-plugin/plugin.json');
if (cp) {
  need(cp, 'name', 'claude plugin');
  need(cp, 'description', 'claude plugin');
}

const xm = readJSON('plugins/codex/.agents/plugins/marketplace.json');
if (xm) {
  need(xm, 'name', 'codex marketplace');
  need(xm, 'interface.displayName', 'codex marketplace');
  if (!Array.isArray(xm.plugins) || xm.plugins.length === 0) {
    fail('codex marketplace: `plugins` must be a non-empty array');
  } else for (const p of xm.plugins) {
    need(p, 'name', 'codex marketplace entry');
    need(p, 'source.source', 'codex marketplace entry');
    need(p, 'source.path', 'codex marketplace entry');
    need(p, 'policy.installation', 'codex marketplace entry');
    need(p, 'policy.authentication', 'codex marketplace entry');
    need(p, 'category', 'codex marketplace entry');
  }
}
const xp = readJSON('plugins/codex/plugins/palmagent/.codex-plugin/plugin.json');
if (xp) {
  need(xp, 'name', 'codex plugin');
  const v = need(xp, 'version', 'codex plugin');
  if (v && !/^\d+\.\d+\.\d+([-+].+)?$/.test(v)) fail(`codex plugin: \`version\` must be semver (got "${v}")`);
  need(xp, 'description', 'codex plugin');
  need(xp, 'author.name', 'codex plugin');
  need(xp, 'interface', 'codex plugin');
  if ('hooks' in xp) fail('codex plugin: `hooks` is rejected by the Codex validator — remove it');
  for (const u of ['homepage', 'repository', 'interface.websiteURL', 'interface.privacyPolicyURL', 'interface.termsOfServiceURL']) {
    const val = dig(xp, u);
    if (val && !/^https:\/\//.test(val)) fail(`codex plugin: \`${u}\` must be an absolute https:// URL`);
  }
}

// ---- 3. source-path integrity + name consistency + folder == name ---------
if (cm?.plugins) for (const p of cm.plugins) {
  if (typeof p.source === 'string' && !existsSync(join(ROOT, p.source, '.claude-plugin/plugin.json'))) {
    fail(`claude marketplace source \`${p.source}\` has no .claude-plugin/plugin.json`);
  }
}
if (xm?.plugins) for (const p of xm.plugins) {
  const path = p.source?.path;
  if (path) {
    if (!existsSync(join(ROOT, 'plugins/codex', path, '.codex-plugin/plugin.json'))) {
      fail(`codex marketplace path \`${path}\` has no .codex-plugin/plugin.json`);
    }
    const folder = path.split('/').filter(Boolean).pop();
    if (folder !== p.name) fail(`codex: folder \`${folder}\` != marketplace entry name \`${p.name}\``);
    if (xp && xp.name !== folder) fail(`codex: plugin.json name \`${xp.name}\` != folder \`${folder}\``);
  }
}
for (const id of [cm?.name, cm?.plugins?.[0]?.name, cp?.name, xm?.name, xm?.plugins?.[0]?.name, xp?.name].filter(Boolean)) {
  if (id !== 'palmagent') fail(`identity mismatch: expected "palmagent", found "${id}"`);
}

// ---- 4. SKILL.md frontmatter (name + description) -------------------------
for (const sd of ['skills', 'plugins/claude/skills', 'plugins/codex/plugins/palmagent/skills']) {
  const abs = join(ROOT, sd);
  if (!existsSync(abs)) continue;
  for (const n of readdirSync(abs)) {
    const f = join(abs, n, 'SKILL.md');
    if (!existsSync(f)) continue;
    const fm = readFileSync(f, 'utf8').match(/^---\n([\s\S]*?)\n---/);
    if (!fm) { fail(`${relative(ROOT, f)}: missing YAML frontmatter`); continue; }
    if (!/^name:\s*\S/m.test(fm[1])) fail(`${relative(ROOT, f)}: frontmatter missing \`name\``);
    if (!/^description:\s*\S/m.test(fm[1])) fail(`${relative(ROOT, f)}: frontmatter missing \`description\``);
  }
}

// ---- version-controlled files (plus untracked candidates) ----------------
// Respect .gitignore so dependency/build output is never scanned as source.
const allFiles = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: ROOT, encoding: 'utf8' },
).split('\0').filter(Boolean).map((path) => join(ROOT, path));

// ---- 6. relative-link existence in markdown -------------------------------
for (const f of allFiles.filter((p) => p.endsWith('.md'))) {
  const txt = readFileSync(f, 'utf8');
  for (const m of txt.matchAll(/\]\(([^)]+)\)/g)) {
    let t = m[1].trim();
    if (/^(https?:|mailto:|#)/.test(t)) continue;
    t = t.split('#')[0];
    if (!t) continue;
    if (!existsSync(join(dirname(f), t))) fail(`${relative(ROOT, f)}: broken relative link → ${t}`);
  }
}

// ---- 7. leak guard (generic patterns + secret denylist) -------------------
const SELF = fileURLToPath(import.meta.url);
const GENERIC = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,   // email
  /\/(?:home|Users)\/[A-Za-z0-9._-]+/,                    // host home path
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,                          // IPv4
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/,                       // GitHub token
  /\bsk-[A-Za-z0-9]{16,}\b/,                              // OpenAI-style key
  /\bAKIA[0-9A-Z]{16}\b/,                                 // AWS access key id
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,                   // PEM private key
];
const denylist = (process.env.LEAK_DENYLIST || '')
  .split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
const requireDenylist = /^(?:1|true)$/i.test(process.env.REQUIRE_LEAK_DENYLIST || '');

const hits = new Set();
for (const f of allFiles) {
  if (f === SELF) continue;                               // scanner defines the patterns
  if (['.png', '.jpg', '.jpeg', '.gif', '.ico'].includes(extname(f).toLowerCase())) continue;
  let txt;
  try { txt = readFileSync(f, 'utf8'); } catch { continue; }
  txt.split('\n').forEach((line, i) => {
    const at = `${relative(ROOT, f)}:${i + 1}`;
    if (GENERIC.some((re) => re.test(line))) { hits.add(at); return; }
    const lc = line.toLowerCase();
    if (denylist.some((tok) => lc.includes(tok.toLowerCase()))) hits.add(at);
  });
}
if (hits.size) {
  fail(`leak guard: ${hits.size} match(es) — values redacted, inspect these locally:\n    ${[...hits].join('\n    ')}`);
}
if (!denylist.length && requireDenylist) {
  fail('leak guard: LEAK_DENYLIST is required for this trusted CI context but is absent');
} else if (!denylist.length) {
  console.log('· leak guard: context denylist not configured (LEAK_DENYLIST absent) — generic patterns still enforced');
}

// ---- report ---------------------------------------------------------------
if (errors.length) {
  console.error(`\n✗ validate: ${errors.length} problem(s)\n`);
  for (const e of errors) console.error('  • ' + e);
  process.exit(1);
}
console.log('✓ validate: all checks passed');
