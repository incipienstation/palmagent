/** Normalize URL-style IPv6 brackets without changing the listener address. */
export function normalizeHost(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}
export function isLoopbackHost(value: string): boolean {
  const host = normalizeHost(value).toLowerCase();
  return host === "localhost" || host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host) && host.split(".").every(part => Number(part) <= 255);
}
export function httpOrigin(host: string, port: number): string {
  const address = normalizeHost(host);
  return `http://${address.includes(":") ? `[${address}]` : address}:${port}`;
}
export function isAllowedProxyTarget(target: string): boolean {
  const url = new URL(target);
  return url.protocol === "https:" || url.protocol === "http:" && isLoopbackHost(url.hostname);
}
