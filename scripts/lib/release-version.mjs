import { PRODUCT_VERSION, compareProductVersions } from '../../packages/shared/src/product-version.mjs';
export const RELEASE_VERSION = PRODUCT_VERSION;
export function compareVersions(a, b) {
  versionPolicy(a); versionPolicy(b);
  return compareProductVersions(a, b);
}

export function versionPolicy(version) {
  if (typeof version !== 'string' || !RELEASE_VERSION.test(version) || version === '0.0.0') {
    throw new Error('Unsupported release version; use X.Y.Z or X.Y.Z-alpha|beta|rc.N');
  }
  const prerelease = version.includes('-');
  return { version, channel: prerelease ? 'next' : 'latest', branch: prerelease ? 'develop' : 'main' };
}
