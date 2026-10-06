import { BRANDING } from "@palmagent/shared";

/** Installed names are compatibility contracts shared by installation, probes and removal. */
function artifacts(kind: "execution" | "terminal", action: string, retainedLauncher: string) {
  const base = `${BRANDING.unitBase}-${kind}`;
  const sliceName = `${base}s.slice`;
  return {
    kind, sliceName, unitName: (id: string) => `${base}@${id}.service`,
    templatePath: `/etc/systemd/system/${base}@.service`,
    slicePath: `/etc/systemd/system/${sliceName}`,
    helperPath: `/usr/local/libexec/${base}-${action}`,
    sudoersPath: `/etc/sudoers.d/${base}s`,
    candidatePath: `/etc/sudoers.d/.${base}s-candidate`,
    sourceLauncher: `${kind}-launcher.js`, retainedLauncher,
  };
}
export const HOST_ARTIFACTS = {
  execution: artifacts("execution", "start", "launcher.mjs"),
  terminal: artifacts("terminal", "control", "terminal-launcher.mjs"),
};
export type HostArtifacts = typeof HOST_ARTIFACTS.execution;
export function installedHostArtifactPaths(): string[] {
  return Object.values(HOST_ARTIFACTS).flatMap(spec => [spec.templatePath, spec.slicePath, spec.sudoersPath, spec.helperPath]);
}
