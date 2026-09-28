// Pure product version grammar and ordering, usable by Node tooling and bundled runtime.
export const PRODUCT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/;
export function productVersion(value) {
  const match = typeof value === "string" && PRODUCT_VERSION.exec(value);
  if (!match) throw new Error(`unsupported Palmagent version: ${value}`);
  return { base: match.slice(1, 4).join("."), parts: match.slice(1, 4).map(Number),
    stage: match[4] ? ({ alpha: 0, beta: 1, rc: 2 }[match[4]] ?? 3) : 3,
    sequence: Number(match[5] ?? 0), prerelease: !!match[4] };
}
export function compareProductVersions(left, right) {
  const a = productVersion(left), b = productVersion(right);
  const av = [...a.parts, a.stage, a.sequence], bv = [...b.parts, b.stage, b.sequence];
  for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return Math.sign(av[i] - bv[i]);
  return 0;
}
