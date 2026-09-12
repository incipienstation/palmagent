export const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/;

export function compareVersions(a, b) {
  const parts = (version) => {
    versionPolicy(version);
    const [base, suffix] = version.split('-');
    const [stage, sequence] = (suffix ?? '').split('.');
    return [...base.split('.').map(Number), { alpha: 0, beta: 1, rc: 2 }[stage] ?? 3, Number(sequence ?? 0)];
  };
  const x = parts(a), y = parts(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export function versionPolicy(version) {
  if (typeof version !== 'string' || !RELEASE_VERSION.test(version) || version === '0.0.0') {
    throw new Error('Unsupported release version; use X.Y.Z or X.Y.Z-alpha|beta|rc.N');
  }
  const prerelease = version.includes('-');
  return { version, channel: prerelease ? 'next' : 'latest', branch: prerelease ? 'develop' : 'main' };
}
