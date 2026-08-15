// Fail-closed leak scan for the assembled public package.
//
// Always-on patterns cover common secret shapes. LEAK_DENYLIST supplies
// project-specific private context without committing those values. Output
// is limited to file and line locations so CI logs never repeat a match.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const target = process.argv[2] ?? "build/pkg";

// Files whose bytes aren't text we can meaningfully scan (icons/fonts/images).
const SKIP_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
]);

const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub PAT / OAuth / user / server tokens
  /\bsk-(?:ant|proj)-[A-Za-z0-9_-]{16,}/, // Anthropic / OpenAI project keys
  /\bsk-[A-Za-z0-9]{32,}/, // classic OpenAI secret key
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}/, // Stripe secret keys
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access-key id
  /-----BEGIN (?:[A-Z ]*)PRIVATE KEY-----/, // PEM private keys
];
const envDeny = (process.env.LEAK_DENYLIST ?? "")
  .split(/[\n,]/)
  .map((t) => t.trim().toLowerCase())
  .filter(Boolean);

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

let files;
try {
  files = walk(target);
} catch (e) {
  console.error(
    `[pkg-leakcheck] cannot scan ${target}: ${e.message} — run \`pnpm pkg:build\` first.`,
  );
  process.exit(2);
}

const hits = new Set(); // "rel:line" — location only, never the token
for (const f of files) {
  if (SKIP_EXT.has(f.slice(f.lastIndexOf(".")).toLowerCase())) continue;
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue; // unreadable / truly binary
  }
  const rel = relative(target, f);
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lc = line.toLowerCase();
    const bad =
      SECRET_PATTERNS.some((re) => re.test(line)) ||
      envDeny.some((tok) => lc.includes(tok));
    if (bad) hits.add(`${rel}:${i + 1}`);
  }
}

const requireDenylist = /^(?:1|true)$/i.test(
  process.env.REQUIRE_LEAK_DENYLIST ?? "",
);
if (!envDeny.length && requireDenylist) {
  console.error(
    "[pkg-leakcheck] FAIL — LEAK_DENYLIST is required in this release context",
  );
  process.exit(1);
}
if (!envDeny.length) {
  console.log(
    "· pkg-leakcheck: context denylist absent — generic secret patterns still enforced",
  );
}

if (hits.size) {
  console.error(
    `\n[pkg-leakcheck] FAIL — ${hits.size} location(s) match a leak pattern (token redacted):`,
  );
  for (const h of [...hits].sort()) console.error(`  ✗ ${h}`);
  console.error(
    "\nScrub the matched content and rebuild. See scripts/pkg-leakcheck.mjs.",
  );
  process.exit(1);
}

console.log(
  `[pkg-leakcheck] PASS — ${files.length} file(s) scanned in ${target}, no leaks`,
);
