const GENERIC = [
  /\/(?:home|Users)\/[A-Za-z0-9._-]+/,                    // host home path
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,                          // IPv4
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/,                       // GitHub token
  /\bsk-(?:(?:proj|ant)-[A-Za-z0-9_-]{16,}|[A-Za-z0-9]{16,})\b/, // provider key
  /\bAKIA[0-9A-Z]{16}\b/,                                 // AWS access key id
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,                   // PEM private key
];

export function leakLines(text, path) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    // Registry-authored deprecation prose is immutable third-party metadata.
    if (path === 'pnpm-lock.yaml' && /^\s*deprecated:/.test(line)) return;
    if (GENERIC.some(pattern => pattern.test(line))) hits.push(i + 1);
  });
  return hits;
}
