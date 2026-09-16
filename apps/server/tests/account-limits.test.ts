import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccountLimitReader, parseAccountLimits, readCliAccountLimits } from "../src/account-limits.js";

const reset = "2030-01-02T00:00:00Z";
test("Claude quotas preserve missing values, model windows and extra usage without session/private fields", () => {
  const report = parseAccountLimits("claude", {
    subscription_type: "max", rate_limits_available: true,
    session: { total_cost_usd: 99 }, accountId: "fixture-private-id",
    rate_limits: {
      five_hour: { utilization: 0, resets_at: reset },
      seven_day: { utilization: null, resets_at: reset },
      seven_day_sonnet: { utilization: 50, resets_at: null },
      model_scoped: [{ display_name: "Sonnet", utilization: 60, resets_at: reset }, { display_name: "Fable", utilization: 99, resets_at: reset }],
      extra_usage: { is_enabled: true, utilization: 12 },
    },
  }, 123);
  assert.equal(report.agent, "claude");
  if (report.agent !== "claude") return;
  assert.equal(report.state, "ready");
  assert.deepEqual(report.fiveHour, { usedPercent: 0, resetsAt: Date.parse(reset) });
  assert.equal(report.sevenDay?.usedPercent, null);
  assert.equal(report.modelLimits.length, 2);
  assert.equal(report.modelLimits[0].window.usedPercent, 60);
  assert.deepEqual(report.extraUsage, { usedPercent: 12 });
  assert.doesNotMatch(JSON.stringify(report), /fixture-private-id|session|total_cost|subscription_type/);
  assert.equal(parseAccountLimits("claude", { rate_limits_available: false, rate_limits: null }, 1).state, "unavailable");
  assert.throws(() => parseAccountLimits("claude", { rate_limits_available: true, rate_limits: null }, 1));
  assert.throws(() => parseAccountLimits("claude", {}, 1));
});

test("Codex multi-bucket quotas use actual durations, retain credits, and do not double count the legacy view", () => {
  const report = parseAccountLimits("codex", { accountId: "fixture-private-id", rateLimits: { limitId: "codex", primary: { usedPercent: 90 } }, rateLimitsByLimitId: {
    spark: { limitName: "Spark", primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1000 }, secondary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: 2000 } },
    codex: { primary: { usedPercent: 21, windowDurationMins: 10080, resetsAt: 3000 }, secondary: null, credits: { hasCredits: true, unlimited: false, balance: "12.50" } },
  } }, 123);
  assert.equal(report.agent, "codex");
  if (report.agent !== "codex") return;
  assert.equal(report.buckets.length, 2);
  assert.equal(report.buckets[0].id, "codex");
  assert.deepEqual(report.buckets[0].primary, { usedPercent: 21, windowMinutes: 10080, resetsAt: 3000000 });
  assert.equal(report.buckets[0].secondary, undefined);
  assert.deepEqual(report.buckets[0].credits, { unlimited: false, balance: "12.50" });
  assert.doesNotMatch(JSON.stringify(report), /fixture-private-id/);
  const old = parseAccountLimits("codex", { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300 }, credits: { unlimited: true } } }, 0);
  assert.equal(old.agent === "codex" && old.buckets[0].primary?.usedPercent, 100);
});

test("malformed or absent quota numbers never become a full allowance", () => {
  const report = parseAccountLimits("codex", { rateLimits: { primary: { usedPercent: "10", resetsAt: null }, secondary: { usedPercent: -1, windowDurationMins: "300", resetsAt: 1234 } } }, 0);
  assert.equal(report.agent, "codex");
  if (report.agent !== "codex") return;
  assert.equal(report.buckets[0].primary, undefined);
  assert.deepEqual(report.buckets[0].secondary, { usedPercent: null, windowMinutes: null, resetsAt: 1234000 });
  assert.equal(parseAccountLimits("codex", { rateLimits: {} }, 0).state, "unavailable");
  const claude = parseAccountLimits("claude", { rate_limits_available: true, rate_limits: { five_hour: { utilization: NaN, resets_at: "invalid" } } }, 0);
  assert.equal(claude.state, "unavailable");
});

test("account reads coalesce across tasks, isolate provider homes, expire, and replace failed reports", async () => {
  let now = 1, reads = 0, fail = false;
  const reader = new AccountLimitReader(async () => {
    reads++;
    if (fail) throw new Error("sensitive CLI error");
    return { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300 } } };
  }, () => now);
  const first = reader.get("codex", "/fixture/account-one");
  assert.equal(reader.get("codex", "/fixture/account-one"), first);
  await first;
  await reader.get("codex", "/fixture/account-two");
  assert.equal(reads, 2);
  now += 300001; fail = true;
  const failed = await reader.get("codex", "/fixture/account-one");
  assert.equal(failed.state, "error");
  assert.equal(failed.agent === "codex" && failed.buckets.length, 0);
  assert.doesNotMatch(JSON.stringify(failed), /sensitive/);
  await reader.get("codex", "/fixture/account-one");
  assert.equal(reads, 3);
});

test("installed CLI protocol reads use the selected home and never start a model turn; timed-out readers exit", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "palmagent-limit-test-"));
  const bin = join(dir, "bin"), home = join(dir, "account");
  mkdirSync(bin); mkdirSync(home);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => { process.env.PATH = path; rmSync(dir, { recursive: true, force: true }); });
  const fixture = join(bin, "fixture.cjs");
  writeFileSync(fixture, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const claude = path.basename(process.argv[1]) === 'claude';
const home = process.env[claude ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'];
fs.writeFileSync(path.join(home, 'pid'), String(process.pid));
if (fs.existsSync(path.join(home, 'descendant'))) {
 const child = require('node:child_process').spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], {stdio:'inherit'});
 fs.writeFileSync(path.join(home, 'descendant-pid'), String(child.pid));
 setTimeout(() => process.exit(0), 100);
}
readline.createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line);
 fs.appendFileSync(path.join(home, 'requests'), line + '\\n');
 if (fs.existsSync(path.join(home, 'hang'))) return;
 if (claude) process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{rate_limits_available:true,rate_limits:{five_hour:{utilization:25,resets_at:'${reset}'}}}}})+'\\n');
 else if (m.id === 1) process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n');
 else if (m.id === 2) process.stdout.write(JSON.stringify({id:2,result:{rateLimits:{primary:{usedPercent:50,windowDurationMins:300,resetsAt:1000}}}})+'\\n');
});
`, { mode: 0o755 });
  symlinkSync(fixture, join(bin, "claude")); symlinkSync(fixture, join(bin, "codex"));
  const claude = await readCliAccountLimits("claude", home);
  assert.equal(parseAccountLimits("claude", claude, 0).state, "ready");
  const codex = await readCliAccountLimits("codex", home);
  assert.equal(parseAccountLimits("codex", codex, 0).state, "ready");
  const requests = readFileSync(join(home, "requests"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(requests[0].request, { subtype: "get_usage", skip_behaviors: true });
  assert.deepEqual(requests.slice(1).map(r => r.method), ["initialize", "initialized", "account/rateLimits/read"]);
  writeFileSync(join(home, "hang"), "");
  await assert.rejects(readCliAccountLimits("codex", home, 1000), /timed out/);
  const pid = Number(readFileSync(join(home, "pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  if (process.platform === "linux") {
    writeFileSync(join(home, "descendant"), "");
    await assert.rejects(readCliAccountLimits("codex", home, 1000), /timed out/);
    const descendant = Number(readFileSync(join(home, "descendant-pid"), "utf8"));
    try {
      // A reparented child may briefly remain as a zombie until init reaps it.
      assert.match(readFileSync(`/proc/${descendant}/stat`, "utf8"), /\) Z /);
    } catch (error) {
      // Reaping during the procfs read can return ESRCH as well as ENOENT.
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
});
