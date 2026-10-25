import type { UpdateChannel, UpdateReceipt, UpdateRequest } from "@palmagent/shared/updates";
import type { InstallConfig } from "../../../domain/installation.js";
import type { ActivationReceipt, ApplicationIdentity, Check, MigrationReceipt, NativePlugin, RuntimeActivity } from "../../../domain/installation-observations.js";
import type { PluginVersion, UpdatePlan } from "../../../domain/update-plan.js";
import type { InstallationOptions } from "../inbound/installation-use-cases.js";

export interface InstallationConfiguration {
  exists(dataDir?: string): boolean;
  load(dataDir?: string): InstallConfig;
  resolve(options: InstallationOptions, requireInstalled?: boolean): Promise<InstallConfig>;
  save(config: InstallConfig): string;
  preferences(dataDir: string): { channel: UpdateChannel; autoUpdate?: boolean };
  persistChannel(config: InstallConfig, explicitlySelected: boolean): void;
  initializePreferences(dataDir: string): void;
  assertPurgeTarget(dataDir: string): void;
}
export interface InstallationState {
  lock(): () => void;
  beginMaintenance(config: InstallConfig): () => void;
  parentOwnsMaintenance(config: InstallConfig): boolean;
  readUpdate(dataDir: string): UpdateReceipt | undefined;
  writeUpdate(dataDir: string, receipt: Omit<UpdateReceipt, "schemaVersion" | "checkedAt">): void;
  clearDiscovery(dataDir: string): void;
  validRequest(config: InstallConfig, request: UpdateRequest): boolean;
  clearRequest(config: InstallConfig, id?: string): void;
  readMigration(config: InstallConfig): MigrationReceipt | undefined;
  writeMigration(config: InstallConfig, receipt: MigrationReceipt): void;
  clearMigration(config: InstallConfig): void;
  writeActivation(config: InstallConfig, receipt: ActivationReceipt): void;
}
/** Prepared host artifacts stay private to the adapter; only redacted changes are printable. */
export interface PreparedSetup {
  summary: readonly string[];
  apply(): void;
}
/** Host facts and operations. Admission, retry and rollback decisions belong to the use cases. */
export interface InstallationRuntime {
  assertIdentity(): void;
  assertOwner(config: InstallConfig): void;
  assertBootstrapSupported(): void;
  canManageServices(): boolean;
  preflight(): Check[];
  prepareUserService(config: InstallConfig, dryRun?: boolean): void;
  verifyUserIsolation(config: InstallConfig): void;
  retainRelease(config: InstallConfig): void;
  prepareSetup(config: InstallConfig): PreparedSetup;
  configure(config: InstallConfig, dryRun: boolean): { runnerChanged: boolean };
  artifactChanged(config: InstallConfig): boolean;
  installBootstrap(config: InstallConfig, activate?: boolean): void;
  start(config: InstallConfig): Promise<void>;
  restartRunner(config: InstallConfig): void;
  restartWeb(config: InstallConfig): Promise<void>;
  healthy(config: InstallConfig, version?: string): boolean;
  waitHealthy(config: InstallConfig, version?: string): Promise<boolean>;
  activity(config: InstallConfig): Promise<RuntimeActivity>;
  legacyIdle(config: InstallConfig): Promise<boolean>;
  verifyCompatibility(config: InstallConfig): void;
  assertExecutionsFinished(config: InstallConfig): void;
  configureAutoUpdate(config: InstallConfig): Promise<void>;
  retireAutoUpdateTimer(): void;
  serviceDescription(config: InstallConfig): string;
  healthFailureHint(config: InstallConfig): string;
  validateCandidate(config: InstallConfig): void;
  snapshotDaemonConfig(config: InstallConfig): string | undefined;
  configureDaemon(config: InstallConfig): void;
  stopPrevious(config: InstallConfig): Promise<void>;
  restoreBootstrap(config: InstallConfig): void;
  removeCandidate(config: InstallConfig, started: boolean): Promise<void>;
  restorePrevious(config: InstallConfig, daemonConfig?: string, cause?: unknown): Promise<void>;
  finishMigration(config: InstallConfig): void;
  removeServices(config: InstallConfig): Promise<void>;
  purge(config: InstallConfig): void;
  retainedCandidate(config: InstallConfig, packageDirectory: string, node: string): InstallConfig;
  provisionCandidate(config: InstallConfig, dryRun: boolean): void;
  isPostUpgrade(): boolean;
}
export interface InstallationReleases {
  installedVersion(packageDirectory?: string): string;
  stage(config: InstallConfig, version: string): InstallConfig;
  identity(packageDirectory: string): ApplicationIdentity;
  verifyCli(config: InstallConfig, version: string, retained: boolean): void;
  verifyApplication(identity: ApplicationIdentity, config: InstallConfig): Promise<void>;
  globalPrefix(config: InstallConfig): string;
  installGlobal(version: string, prefix: string): boolean;
  activateInstalled(config: InstallConfig, options: InstallationOptions, version: string): void;
  readPlugins(paths: string[]): PluginVersion[];
  discoverPlugins(config: InstallConfig): NativePlugin[];
  participatingPlugins(native: NativePlugin[], paths: string[]): PluginVersion[];
  resolvePlan(current: string, channel: UpdateChannel, plugins: PluginVersion[], requested?: string): UpdatePlan;
  refreshPlugins(config: InstallConfig, plan: UpdatePlan, native: NativePlugin[]): NativePlugin[];
  canonicalPluginPath(path: string): string;
}
/** Interactive output is a secondary port, allowing the workflow to request input at safe points. */
export interface InstallationFeedback {
  step(message: string): void;
  info(message: string): void;
  ok(message: string): void;
  warn(message: string): void;
  err(message: string): void;
  plain(message: string): void;
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
  checks(title: string, checks: Check[]): void;
  plan(plan: UpdatePlan): void;
}
export interface InstallationDiagnostics {
  doctor(config: InstallConfig): Check[] | Promise<Check[]>;
  application(config: InstallConfig): Promise<Check[]>;
}
export interface InstallationDependencies {
  configuration: InstallationConfiguration;
  state: InstallationState;
  runtime: InstallationRuntime;
  releases: InstallationReleases;
  feedback: InstallationFeedback;
  diagnostics: InstallationDiagnostics;
}

export interface RetainedReleaseOperations {
  stageRelease(config: InstallConfig, version: string): InstallConfig;
  verifyActiveExecutionCompatibility(config: InstallConfig): void;
  assertExecutionsFinished(config: InstallConfig): void;
}
