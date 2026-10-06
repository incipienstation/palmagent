import assert from "node:assert/strict";
import test from "node:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { httpOrigin, isAllowedProxyTarget, isLoopbackHost } from "@palmagent/shared";
import { resolveStateDirectory } from "../../src/platform/filesystem/paths.js";
import { Port, PushSubject } from "../../src/modules/installation/adapters/inbound/config-fields.js";
import { validateInstallInput } from "../../src/modules/installation/adapters/outbound/config.js";

test("listener addresses and URL hosts share IPv6 loopback rules", () => {
  for (const host of ["localhost", [127, 0, 0, 1].join("."), [127, 2, 3, 4].join("."), "::1", "[::1]"]) {
    assert.ok(isLoopbackHost(host));
    assert.ok(isAllowedProxyTarget(new URL(httpOrigin(host, 4100))));
    assert.equal(validateInstallInput({ domain: "example.com", host, port: 4100, concurrency: 8, pushSubject: "" }).host, host.replace(/[\[\]]/g, ""));
  }
  for (const host of [[127, 999, 0, 1].join("."), "example.com", "::2"]) assert.equal(isLoopbackHost(host), false);
  assert.equal(isAllowedProxyTarget(new URL("http://example.com")), false);
  assert.equal(isAllowedProxyTarget(new URL("https://example.com")), true);
  assert.equal(httpOrigin("::1", 4100), "http://[::1]:4100");
});
test("state directory precedence is explicit, installation env, XDG, then home", () => {
  const env = { DISPATCHER_DATA_DIR: "/fixture/install", XDG_STATE_HOME: "/fixture/state" };
  assert.equal(resolveStateDirectory("product", "/fixture/explicit", env), "/fixture/explicit");
  assert.equal(resolveStateDirectory("product", undefined, env), "/fixture/install");
  assert.equal(resolveStateDirectory("product", undefined, { XDG_STATE_HOME: "/fixture/state" }), "/fixture/state/product");
  assert.equal(resolveStateDirectory("product", undefined, {}), join(homedir(), ".local/state/product"));
  assert.equal(resolveStateDirectory("product", "~/custom", env), join(homedir(), "custom"));
});
test("runtime and installer reject out-of-range ports and invalid push contacts", () => {
  for (const port of [0, 70000, 1.5]) {
    assert.equal(Port.safeParse(port).success, false);
    assert.throws(() => validateInstallInput({ domain: "example.com", host: "localhost", port, concurrency: 8, pushSubject: "" }));
  }
  for (const value of ["mailto:", "https://", "invalid"]) assert.equal(PushSubject.safeParse(value).success, false);
});

test("legacy permissions have one execution meaning across provider adapters", async () => {
  const { codexSandbox, normalizePermission, permissionAlias, DEFAULT_PERMISSION } = await import("@palmagent/shared");
  assert.deepEqual(codexSandbox("workspace-write-net"), { mode: "workspace-write", network: true });
  assert.deepEqual(codexSandbox("readonly"), { mode: "read-only" });
  assert.deepEqual(codexSandbox("full"), { mode: "danger-full-access" });
  assert.equal(normalizePermission("claude", "full"), "bypassPermissions");
  assert.equal(normalizePermission("claude", "default"), "auto");
  assert.equal(normalizePermission("codex", "unknown"), DEFAULT_PERMISSION.codex);
  assert.equal(permissionAlias("codex", "unknown"), "unknown", "display preserves unknown persisted vocabulary");
});
