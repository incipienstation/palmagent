import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "@palmagent/shared";
import { observeTurn, turnFailed, type TurnEvidence } from "../../../src/modules/tasks/domain/turn-policy.js";

function evidence(...events: Pick<AgentEvent, "kind" | "payload">[]): TurnEvidence {
  const state = { sawResult: false, lastResultError: false, errored: false };
  for (const event of events) observeTurn(state, event);
  return state;
}
const success = { kind: "result", payload: { is_error: false } } as const;
const failure = { kind: "result", payload: { is_error: true } } as const;
const error = { kind: "error", payload: { message: "transient failure" } } as const;

test("the last terminal result supersedes errors and earlier interrupted results", () => {
  assert.equal(turnFailed(evidence(error, failure, success), false, false), false);
  assert.equal(turnFailed(evidence(success, failure), false, false), true);
  assert.equal(turnFailed(evidence(error), false, false), true);
  assert.equal(evidence(error).failureMessage, "transient failure");
});

test("abnormal exits and lost backends override a successful result", () => {
  for (const payload of [{ subtype: "process_exit", code: 1 }, { subtype: "process_exit", code: null }, { subtype: "reattach_failed" }]) {
    assert.equal(turnFailed(evidence(success, { kind: "status", payload }), false, false), true);
  }
  assert.equal(turnFailed(evidence(success, { kind: "status", payload: { subtype: "process_exit", code: 0 } }), false, false), false);
});

test("intentional settings restarts may chain, while compaction still requires a terminal result", () => {
  assert.equal(turnFailed(evidence(failure), false, true), false);
  assert.equal(turnFailed(evidence(), false, false), false);
  assert.equal(turnFailed(evidence(), true, false), true);
  assert.equal(turnFailed(evidence(error), true, true), true);
  assert.equal(turnFailed(evidence(success), true, false), false);
});
