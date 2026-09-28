import { expect, test } from "@playwright/test";
import { createRequestScope } from "../../src/hooks/request-scope";
import { resetClientSession } from "../../src/query-lifecycle";

test("superseded responses and errors cannot publish even when transport ignores cancellation", async () => {
  const scope = createRequestScope();
  let resolveOld!: (value: string) => void;
  let rejectOld!: (error: Error) => void;
  const oldResponse = new Promise<string>(resolve => { resolveOld = resolve; });
  const oldFailure = new Promise<string>((_, reject) => { rejectOld = reject; });
  let visible = "", busy = false, error = "";
  const load = async (response: Promise<string>) => {
    const request = scope.begin(); busy = true;
    try { const value = await response; if (request.isCurrent()) visible = value; }
    catch { if (request.isCurrent()) error = "failed"; }
    finally { if (request.isCurrent()) busy = false; }
  };
  const a = load(oldResponse), b = load(oldFailure);
  const latest = scope.begin(); busy = true; visible = "new scan";
  resolveOld("old scan"); rejectOld(new Error("old error")); await Promise.all([a,b]);
  expect({ visible, busy, error }).toEqual({ visible: "new scan", busy: true, error: "" });
  expect(latest.isCurrent()).toBe(true);
  scope.cancel(); expect(latest.signal.aborted).toBe(true); expect(latest.isCurrent()).toBe(false);
});

test("read lanes are independent and session reset invalidates all outstanding tickets", () => {
  const discover = createRequestScope(), browse = createRequestScope();
  const a = discover.begin(), b = browse.begin();
  const newer = discover.begin();
  expect(a.signal.aborted).toBe(true); expect(a.isCurrent()).toBe(false);
  expect(b.isCurrent()).toBe(true);
  resetClientSession();
  expect(b.isCurrent()).toBe(false); expect(newer.isCurrent()).toBe(false);
  expect(discover.begin().isCurrent()).toBe(true);
});
