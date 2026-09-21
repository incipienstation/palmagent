import assert from "node:assert/strict";
import test from "node:test";
import { parseNativeSkills, SkillDiscovery, skillId } from "../src/skills.js";
import { codexInput } from "../src/codex-interactive.js";
import { claudeSkillPrompt } from "../src/claude.js";
import { ExecutionStartSchema, ExecutionCommandSchema } from "@palmagent/shared/executions";
import { SelectedSkillsSchema } from "@palmagent/shared";

const env = { agent: "codex" as const, cwd: "/workspace/project", home: "/agent-home" };
const raw = { data: [{ cwd: env.cwd, skills: [
  { name: "palmagent:doctor", description: "Check the service", path: "/plugins/palmagent/skills/doctor/SKILL.md", scope: "user", pluginId: "palmagent@palmagent", enabled: true },
  { name: "doctor", description: "Project check", path: "/workspace/project/.agents/skills/doctor/SKILL.md", scope: "repo", enabled: true },
  { name: "hidden", path: "/skills/hidden/SKILL.md", enabled: false },
], errors: [] }] };

test("native discovery keeps plugin identity and distinct same-name scopes; disabled skills stay hidden", () => {
  const result = parseNativeSkills(env, raw);
  assert.equal(result.skills.length, 2);
  assert.equal(result.skills.find(s => s.name === "palmagent:doctor")?.pluginId, "palmagent@palmagent");
  assert.equal(result.skills.find(s => s.name === "doctor")?.pluginId, undefined);
  const other = { ...env, home: "/another-profile" };
  assert.notEqual(parseNativeSkills(other, raw).skills[0].id, result.skills[0].id);
  assert.equal(skillId(env, "doctor", "/x"), skillId({ ...env }, "doctor", "/x"));
});

test("Claude command catalogue preserves qualified names and marks only installed plugin namespaces", () => {
  const result = parseNativeSkills({ ...env, agent: "claude" }, { commands: [
    { name: "palmagent:setup", description: "Reconfigure" }, { name: "setup", description: "Project setup" },
    { name: "not invokable", description: "invalid" },
  ] }, ["palmagent@palmagent"]);
  assert.equal(result.skills.length, 2);
  assert.equal(result.skills.find(s => s.name === "palmagent:setup")?.source, "palmagent");
  assert.equal(result.skills.find(s => s.name === "setup")?.pluginId, undefined);
});

test("selection resolution discards forged paths and metadata; stale choices fail closed", async () => {
  let calls = 0, current = raw;
  const discovery = new SkillDiscovery(async () => { calls++; return current; });
  const [one, two] = await Promise.all([discovery.list(env), discovery.list(env)]);
  assert.equal(calls, 1); assert.deepEqual(one, two);
  const chosen = one.skills[0];
  const resolved = await discovery.resolve(env, [{ ...chosen, path: "/secrets", name: "fake", pluginId: "fake" }]);
  assert.equal(resolved?.[0].path, chosen.path); assert.equal(resolved?.[0].name, chosen.name);
  current = { data: [{ cwd: env.cwd, skills: [], errors: [] }] };
  await assert.rejects(discovery.resolve(env, [chosen]), /no longer available/);
  assert.equal(await discovery.resolve(env, []), undefined);
  assert.throws(() => SelectedSkillsSchema.parse([chosen, chosen]));
});

test("both adapters invoke selected skills explicitly without altering stored user text", () => {
  const skill = parseNativeSkills(env, raw).skills.find(s => s.pluginId)!;
  const input = codexInput("Check HTTPS", undefined, [skill]);
  assert.deepEqual(input, [{ type: "text", text: "$palmagent:doctor\nCheck HTTPS", text_elements: [] },
    { type: "skill", name: skill.name, path: skill.path }]);
  assert.equal(claudeSkillPrompt("Check HTTPS", [skill]), "/palmagent:doctor Check HTTPS");
  assert.equal(claudeSkillPrompt("Ordinary message"), "Ordinary message");
  const start = ExecutionStartSchema.parse({ taskId: "t", agent: "codex", cwd: env.cwd, prompt: "Check HTTPS" });
  assert.equal(start.prompt, "Check HTTPS");
  assert.equal(ExecutionCommandSchema.parse({ kind: "send", messageId: "m", text: "Check", skills: [skill] }).kind, "send");
});
