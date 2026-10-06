import { compatibleAgentCli } from "@palmagent/shared";
import type { AgentInstallation, AgentKind } from "@palmagent/shared";
import { ApplicationError } from "../../../../kernel/errors.js";
import type { AgentInstallations } from "../ports/inbound/agent-installations.js";
import type { AgentInstallationHost, InstalledAgent as Installed } from "../ports/outbound/agent-installation.js";
const agents = ["claude", "codex"] as const;

export class AgentInstallationService implements AgentInstallations {
  private cache = new Map<AgentKind, { expires: number; value: Promise<AgentInstallation> }>();
  private updates = new Map<AgentKind, AgentInstallation["update"]>();
  private running = new Map<AgentKind, Promise<void>>();
  private unreadableState = false;

  constructor(private home: (agent: AgentKind) => string, private deps: AgentInstallationHost) {
    try {
      const saved = deps.readUpdates();
      for (const agent of agents) if (saved[agent]) this.updates.set(agent, saved[agent]!.state === "running"
        ? { state: "failed", message: "Palmagent restarted before the update was verified. Check the installed version before retrying." } : saved[agent]!);
    } catch { this.unreadableState = true; }
  }

  private record(agent: AgentKind, update: AgentInstallation["update"]): void {
    const next = new Map(this.updates).set(agent, update);
    try {
      this.deps.writeUpdates(Object.fromEntries(next));
      this.updates.set(agent, update);
    } catch {
      this.unreadableState = true;
      throw new ApplicationError("service_unavailable", "Could not save the update state. Check the installation on the host.");
    }
  }

  async list(): Promise<AgentInstallation[]> {
    return Promise.all(agents.map(agent => this.get(agent)));
  }

  async get(agent: AgentKind): Promise<AgentInstallation> {
    let cached = this.cache.get(agent);
    if (!cached || cached.expires <= this.deps.now()) {
      const value = Promise.all([
        this.deps.inspect(agent, this.home(agent)),
        this.deps.latest(agent).catch(() => null),
      ]).then(([installed, latestVersion]): AgentInstallation => ({
        agent, version: installed.version, installation: installed.installation,
        compatible: installed.version ? compatibleAgentCli(agent, installed.version) : null,
        latestVersion, latestCompatible: latestVersion ? compatibleAgentCli(agent, latestVersion) : null,
        releaseState: latestVersion ? "ready" : "error", checkedAt: this.deps.now(),
        update: { state: "idle" },
      }));
      cached = { expires: this.deps.now() + 60_000, value };
      this.cache.set(agent, cached);
      void value.catch(() => { if (this.cache.get(agent)?.value === value) this.cache.delete(agent); });
    }
    const status = await cached.value;
    // An update may finish while a version/release read is in flight. Never pair
    // its old installed version with the newly successful update receipt.
    if (this.cache.get(agent) !== cached) return this.get(agent);
    return { ...status, update: this.unreadableState
      ? { state: "failed", message: "Saved update state is unavailable. Check the installation on the host." }
      : this.updates.get(agent) ?? { state: "idle" } };
  }

  async update(agent: AgentKind, expectedVersion: string): Promise<AgentInstallation> {
    if (this.unreadableState) throw new ApplicationError("conflict", "Saved update state is unavailable. Check the installation on the host.");
    if (this.running.has(agent)) throw new ApplicationError("conflict", "An update is already running for this agent.");
    // Reserve before any asynchronous probe so simultaneous requests cannot both start.
    let finish!: () => void;
    const running = new Promise<void>(resolve => { finish = resolve; });
    this.running.set(agent, running);
    let unlock: (() => void) | undefined;
    try {
      unlock = this.deps.lock();
      const installed = await this.deps.inspect(agent, this.home(agent));
      if (installed.installation !== "native" || !installed.command || !installed.version) {
        throw new ApplicationError("conflict", "Update this installation with its package manager on the host.");
      }
      if (installed.version !== expectedVersion) throw new ApplicationError("conflict", "The installed version changed. Refresh before updating.");
      const latest = await this.deps.latest(agent).catch(() => null);
      if (!latest) throw new ApplicationError("service_unavailable", "Could not check the release. Refresh before updating.");
      const currentParts = installed.version.split(/[.-]/).slice(0, 3).map(Number);
      const latestParts = latest.split(/[.-]/).slice(0, 3).map(Number);
      const difference = latestParts.map((n, i) => n - currentParts[i]).find(n => n !== 0) ?? 0;
      if (difference < 0) throw new ApplicationError("conflict", "The installed version is newer than the latest release. No downgrade was started.");
      if (installed.version === latest) {
        this.record(agent, { state: "succeeded", message: `Already on the latest release, ${installed.version}.` });
        this.cache.delete(agent);
        this.running.delete(agent); unlock(); finish();
        return this.get(agent);
      }
      const status = await this.get(agent);
      this.record(agent, { state: "running" });
      const release = unlock;
      void this.apply(agent, installed).finally(() => { this.running.delete(agent); release(); finish(); });
      return { ...status, update: { state: "running" } };
    } catch (error) {
      this.running.delete(agent); unlock?.(); finish(); throw error;
    }
  }

  private async apply(agent: AgentKind, installed: Installed): Promise<void> {
    try {
      await this.deps.update(agent, this.home(agent), installed);
      const after = await this.deps.inspect(agent, this.home(agent));
      if (!after.version || after.installation !== "native") throw new Error("Version verification failed");
      this.record(agent, { state: "succeeded", message: after.version === installed.version
        ? `The CLI updater kept version ${after.version}.`
        : `Updated from ${installed.version} to ${after.version}.` });
    } catch {
      const failed = { state: "failed" as const, message: "The update could not be verified. Check the installation on the host before retrying." };
      try { this.record(agent, failed); } catch { this.unreadableState = true; }
    } finally { this.cache.delete(agent); }
  }

  async close(): Promise<void> { await Promise.all(this.running.values()); }
}
