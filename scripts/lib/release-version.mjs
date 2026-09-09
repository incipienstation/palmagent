export const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/;

export function versionPolicy(version) {
  if (typeof version !== 'string' || !RELEASE_VERSION.test(version) || version === '0.0.0') {
    throw new Error('Unsupported release version; use X.Y.Z or X.Y.Z-alpha|beta|rc.N');
  }
  const prerelease = version.includes('-');
  return { version, channel: prerelease ? 'next' : 'latest', branch: prerelease ? 'develop' : 'main' };
}
