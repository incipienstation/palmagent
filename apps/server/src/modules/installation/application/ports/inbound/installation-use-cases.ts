import type { UpdateRequest } from "@palmagent/shared/updates";
import type { InstallConfig } from "../../../domain/installation.js";

/** Named operation inputs; adapters translate command flags into this contract. */
export interface InstallationOptions {
  dryRun: boolean;
  interactive: boolean;
  force: boolean;
  purge: boolean;
  pull: boolean;
  plan?: boolean;
  automatic?: boolean;
  request?: UpdateRequest;
  dataDir?: string;
  channel?: string;
  targetVersion?: string;
  expectedVersion?: string;
  pluginManifests: string[];
  domain?: string;
  host?: string;
  port?: string;
  concurrency?: string;
  repoRoots?: string;
  claudeConfigDir?: string;
  pushSubject?: string;
}

/** A successful request can complete without activation (for example, a deferred automatic update).
 * The CLI maps this result to its exit status; feedback and receipts retain the precise outcome. */
export interface InstallationUseCases {
  install(options: InstallationOptions): Promise<boolean>;
  setup(options: InstallationOptions): Promise<boolean>;
  update(options: InstallationOptions): Promise<boolean>;
  uninstall(options: InstallationOptions): Promise<boolean>;
  prepareRuntime(options: InstallationOptions, packageDirectory: string, node: string): boolean;
  provisionRuntime(config: InstallConfig, options: InstallationOptions): void;
  passkey(options: InstallationOptions, mint: (database: string) => Promise<{ token: string; expiresAt: number }>): Promise<boolean>;
  doctor(options: InstallationOptions): Promise<boolean>;
}
