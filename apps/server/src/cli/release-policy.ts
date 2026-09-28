import { productVersion, compareProductVersions } from "@palmagent/shared";
export { productVersion, compareProductVersions } from "@palmagent/shared";
// Product release policy: plugin contracts are shared only within one x.x.x.
import { UpdateChannelSchema, type UpdateChannel } from "@palmagent/shared/updates";
export type ReleaseChannel = UpdateChannel;

export function releaseChannel(value: string): ReleaseChannel {
  const parsed = UpdateChannelSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error("channel must be stable or preview");
}

export function compatiblePlugin(
  cliVersion: string,
  pluginVersion: string,
): boolean {
  return productVersion(cliVersion).base === productVersion(pluginVersion).base;
}

export function channelTag(channel: ReleaseChannel): "latest" | "next" {
  return channel === "stable" ? "latest" : "next";
}

export function validateUpdateTarget(
  current: string,
  target: string,
  channel: ReleaseChannel,
): string {
  productVersion(current);
  const to = productVersion(target);
  if (channel === "stable" && to.prerelease) {
    throw new Error(
      "Stable cannot install a prerelease; choose --channel preview explicitly",
    );
  }
  if (compareProductVersions(target, current) < 0) {
    throw new Error(`refusing downgrade from ${current} to ${target}; wait for the channel to catch up or use a separately reviewed rollback`);
  }
  return target;
}
