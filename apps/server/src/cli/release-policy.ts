// Product release policy: plugin contracts are shared only within one x.x.x.
import { UpdateChannelSchema, type UpdateChannel } from "@palmagent/shared/updates";
export type ReleaseChannel = UpdateChannel;

export function releaseChannel(value: string): ReleaseChannel {
  const parsed = UpdateChannelSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error("channel must be stable or preview");
}

export function productVersion(value: string) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/.exec(value);
  if (!match) throw new Error(`unsupported Palmagent version: ${value}`);
  return {
    base: match.slice(1, 4).join("."),
    parts: match.slice(1, 4).map(Number),
    stage: match[4] ? ({ alpha: 0, beta: 1, rc: 2 }[match[4]] ?? 3) : 3,
    sequence: Number(match[5] ?? 0),
    prerelease: !!match[4],
  };
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
  const from = productVersion(current);
  const to = productVersion(target);
  if (channel === "stable" && to.prerelease) {
    throw new Error(
      "Stable cannot install a prerelease; choose --channel preview explicitly",
    );
  }
  const a = [...from.parts, from.stage, from.sequence];
  const b = [...to.parts, to.stage, to.sequence];
  for (let i = 0; i < a.length; i++) {
    if (b[i] < a[i]) {
      throw new Error(
        `refusing downgrade from ${current} to ${target}; wait for the channel to catch up or use a separately reviewed rollback`,
      );
    }
    if (b[i] > a[i]) break;
  }
  return target;
}
