import { realpathSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomic } from "../../../../platform/filesystem/private-files.js";
import type { TerminalFiles } from "../../application/ports/outbound/terminal-registry.js";

export const terminalFiles: TerminalFiles = {
  resolveDirectory: realpathSync,
  writeLaunchDescriptor(directory, { id, protocol, release, node }) {
    writePrivateFileAtomic(join(directory, id + ".json"), JSON.stringify({ id, protocol, directory, release, node }));
  },
};
