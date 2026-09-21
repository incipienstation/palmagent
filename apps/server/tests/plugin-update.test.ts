import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverPlugins, refreshPlugins, type PluginCommand } from "../src/cli/plugin-update.js";
import { planUpdate } from "../src/cli/update-plan.js";
import type { InstallConfig } from "../src/cli/config.js";

const old = "0.1.0-alpha.58", target = "0.1.0-alpha.67";
function json(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
function catalog(root: string, manager: string, v: string) {
  json(join(root, manager === "codex" ? ".agents/plugins/marketplace.json" : ".claude-plugin/marketplace.json"), {
    name: "palmagent", plugins: [{ name: "palmagent" }],
  });
  json(join(root, manager === "codex" ? "plugins/palmagent/.codex-plugin/plugin.json" : "plugins/claude/.claude-plugin/plugin.json"), { name: "palmagent", version: v });
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "palmagent-native-update-"));
  const env = { ...process.env };
  process.env.CODEX_HOME = join(root, "codex");
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  t.after(() => { process.env = env; rmSync(root, { recursive: true, force: true }); });
  const cfg = { dataDir: join(root, "state"), claudeConfigDir: "" } as InstallConfig;
  const homes = { codex: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR };
  const registered = { codex: join(root, "previous-codex"), claude: join(root, "previous-claude") };
  const original = { ...registered };
  const versions = { codex: old, claude: old };
  const enabled = { codex: true, claude: true };
  const options = { failInstall: false, wrongVersion: false, managed: false, scope: "user", project: homes.claude, extraPlugin: false };
  function install(manager: "codex" | "claude", v: string) {
    json(join(homes[manager], "plugins/cache/palmagent/palmagent", v, manager === "codex" ? ".codex-plugin/plugin.json" : ".claude-plugin/plugin.json"), { name: "palmagent", version: v });
    versions[manager] = v;
  }
  for (const manager of ["codex", "claude"] as const) { catalog(registered[manager], manager, old); install(manager, old); }
  const calls: { cmd: string; args: string[]; cwd?: string }[] = [];
  const execute: PluginCommand = (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd });
    const ok = (value = "") => ({ ok: true, code: 0, stdout: value, stderr: "" });
    if (cmd === "git") {
      if (args[0] === "clone") {
        assert(args.includes(`v${target}`));
        const checkout = args.at(-1)!;
        catalog(join(checkout, "plugins/codex"), "codex", target);
        catalog(checkout, "claude", target);
        return ok();
      }
      return ok(`v${target}\n`);
    }
    assert(cmd === "codex" || cmd === "claude");
    const manager = cmd;
    assert.equal(opts?.env?.[manager === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"], homes[manager]);
    if (args.includes("--help")) return ok("native help");
    if (args[1] === "list") return ok(JSON.stringify(manager === "codex" ? { installed: [{
      pluginId: "palmagent@palmagent", version: versions.codex, enabled: enabled.codex, installPolicy: options.managed ? "FORCE_INSTALLED" : "AVAILABLE",
    }] } : [{ id: "palmagent@palmagent", version: versions.claude, enabled: enabled.claude,
      scope: options.scope, ...(options.scope !== "user" ? { projectPath: options.project } : {}),
      installPath: join(homes.claude, "plugins/cache/palmagent/palmagent", versions.claude),
    }]));
    if (args[1] === "marketplace") {
      if (args[2] === "list") return ok(JSON.stringify(manager === "codex" ? { marketplaces: [{
        name: "palmagent", root: registered.codex, marketplaceSource: { sourceType: "local", source: registered.codex },
      }] } : [{ name: "palmagent", source: "directory", path: registered.claude, installLocation: registered.claude }]));
      if (args[2] === "remove") { assert.equal(args[3], "palmagent"); registered[manager] = ""; return ok(); }
      if (args[2] === "add") { registered[manager] = args[3]; return ok(); }
    }
    if (args[1] === "add" || args[1] === "update") {
      assert.equal(args[2], "palmagent@palmagent");
      if (options.failInstall && manager === "claude") return { ok: false, code: 1, stdout: "", stderr: "failure" };
      install(manager, options.wrongVersion ? old : target);
      return ok();
    }
    throw new Error(`unexpected command ${cmd} ${args.join(" ")}`);
  };
  const refresh = () => {
    const native = discoverPlugins(cfg, execute);
    return refreshPlugins(cfg, planUpdate(target, target, "preview", native), native, execute);
  };
  return { root, cfg, homes, calls, options, versions, registered, original, enabled, execute, refresh };
}

test("freshness is independent of compatibility, with no downgrade of a newer compatible plugin", () => {
  for (const [installed, action] of [[old, "update"], [target, "keep"], ["0.1.0-beta.1", "keep"]]) {
    const plan = planUpdate(target, target, "preview", [{ manifest: "/opt/plugin.json", version: installed }]);
    assert.equal(plan.packageAction, "keep");
    assert.equal(plan.plugins[0].action, action);
    assert.equal(plan.automaticEligible, true);
  }
  assert.equal(planUpdate(target, target, "preview", [{ manifest: "/opt/plugin.json", version: "0.2.0" }]).automaticEligible, false);
});

test("native inventories discover both installed plugins and verify their actual manifests", (t) => {
  const f = fixture(t);
  const inventory = discoverPlugins(f.cfg, f.execute);
  assert.deepEqual(inventory.map((p) => p.version), [old, old]);
  json(inventory[0].manifest, { name: "palmagent", version: target });
  assert.throws(() => discoverPlugins(f.cfg, f.execute), /does not match its inventory/);
});

test("same-version application updates refresh both managers and retain exact sources and recovery evidence", (t) => {
  const f = fixture(t);
  const result = f.refresh();
  assert.deepEqual(result.map((p) => p.version), [target, target]);
  assert(f.calls.some((c) => c.cmd === "codex" && c.args.join(" ") === "plugin marketplace remove palmagent"));
  assert(!f.calls.some((c) => c.cmd === "claude" && c.args.includes("remove")));
  assert(f.calls.every((c) => !c.args.includes("sudo")));
  const receipt = JSON.parse(readFileSync(join(f.cfg.dataDir, "plugin-update.json"), "utf8"));
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.activation, "new-agent-session-required");
  assert.equal(receipt.originals[0].original.root, f.original.codex);
  assert.equal(receipt.updated.length, 2);
  assert.equal(f.registered.codex, join(receipt.checkout, "plugins/codex"));
});

test("Claude project scope and disabled state survive a refresh", (t) => {
  const f = fixture(t);
  f.options.scope = "project";
  f.options.project = join(f.root, "project");
  f.enabled.claude = false;
  const result = f.refresh();
  assert.equal(result.find((p) => p.manager === "claude")?.enabled, false);
  assert(f.calls.some((c) => c.cmd === "claude" && c.cwd === f.options.project && c.args.join(" ") === "plugin update palmagent@palmagent --scope project"));
});

test("partial failure restores the failed catalog, retains successful compatible updates, and does not claim rollback", (t) => {
  const f = fixture(t);
  f.options.failInstall = true;
  assert.throws(f.refresh, /previous marketplace restored/);
  assert.equal(f.versions.codex, target);
  assert.equal(f.versions.claude, old);
  assert.equal(f.registered.claude, f.original.claude);
  const receipt = JSON.parse(readFileSync(join(f.cfg.dataDir, "plugin-update.json"), "utf8"));
  assert.equal(receipt.status, "failed-catalog-restored");
  assert.equal(receipt.updated.length, 1);
});

test("a successful native command is insufficient when the installed version remains old", (t) => {
  const f = fixture(t);
  f.options.wrongVersion = true;
  assert.throws(f.refresh, /installation did not preserve/);
  assert.equal(f.registered.codex, f.original.codex);
});

test("managed and disabled Codex installs are preserved before any native mutation", (t) => {
  const f = fixture(t);
  for (const state of ["managed", "disabled"]) {
    f.options.managed = state === "managed";
    f.enabled.codex = state !== "disabled";
    assert.throws(f.refresh, /managed or disabled/);
  }
  assert(!f.calls.some((c) => c.cmd === "git" || c.args.includes("remove") || c.args.includes("add")));
});

test("shared marketplaces are never replaced", (t) => {
  const f = fixture(t);
  json(join(f.original.claude, ".claude-plugin/marketplace.json"), { name: "palmagent", plugins: [{ name: "palmagent" }, { name: "unrelated" }] });
  assert.throws(f.refresh, /dedicated Palmagent/);
  assert(!f.calls.some((c) => c.cmd === "git" || (c.args.includes("remove") && !c.args.includes("--help"))));
});


test("manual refresh never downgrades a newer incompatible plugin", (t) => {
  const f = fixture(t);
  f.versions.codex = "0.2.0";
  json(join(f.homes.codex, "plugins/cache/palmagent/palmagent/0.2.0/.codex-plugin/plugin.json"), { name: "palmagent", version: "0.2.0" });
  assert.throws(f.refresh, /Refusing to downgrade/);
  assert(!f.calls.some((c) => c.cmd === "git"));
});
