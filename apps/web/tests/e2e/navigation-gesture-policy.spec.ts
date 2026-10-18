import { test, expect } from "@playwright/test";
import { createNavigationGesturePolicy } from "../../src/navigation-gesture-policy";

test("nested and overlapping surfaces retain input ownership until all claims are released", () => {
  const policy = createNavigationGesturePolicy();
  const changes: boolean[] = [];
  const unsubscribe = policy.subscribe(() => changes.push(policy.isBlocked()));
  expect(policy.isBlocked()).toBe(false);
  const closeGame = policy.acquire();
  const closeDialog = policy.acquire();
  closeGame();
  closeGame(); // Repeated cleanup must not release another surface's claim.
  expect(policy.isBlocked()).toBe(true);
  closeDialog();
  expect(policy.isBlocked()).toBe(false);
  expect(changes).toEqual([true, true, true, false]);
  unsubscribe();
  policy.acquire()();
  expect(changes).toEqual([true, true, true, false]);
});

test("remounting a surface reacquires input without leaking across app instances", () => {
  const policy = createNavigationGesturePolicy();
  const other = createNavigationGesturePolicy();
  const first = policy.acquire();
  expect(other.isBlocked()).toBe(false);
  first();
  const remount = policy.acquire();
  first();
  expect(policy.isBlocked()).toBe(true);
  remount();
  expect(policy.isBlocked()).toBe(false);
});
