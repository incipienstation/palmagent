import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHostReadiness } from "../../src/platform/process/host-readiness.js";
import { processIdentity } from "../../src/platform/process/identity.js";

test("readiness is private, bound to this process, and not inherited by descendants", t => {
  const directory = mkdtempSync(join(tmpdir(), "host-readiness-"));
  const path = join(directory, "host.ready");
  const prior = process.env.PALMAGENT_HOST_READY;
  t.after(() => {
    if (prior === undefined) delete process.env.PALMAGENT_HOST_READY;
    else process.env.PALMAGENT_HOST_READY = prior;
    rmSync(directory, { recursive: true, force: true });
  });
  process.env.PALMAGENT_HOST_READY = path;
  const ready = createHostReadiness();
  assert.equal(process.env.PALMAGENT_HOST_READY, undefined);
  assert.equal(existsSync(path), false, "construction is not readiness");
  ready();
  const first = readFileSync(path, "utf8");
  const value = JSON.parse(first);
  assert.equal(value.pid, process.pid);
  assert.equal(value.start, processIdentity(process.pid));
  assert.equal(typeof value.readyAt, "number");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  ready();
  assert.equal(readFileSync(path, "utf8"), first);
  createHostReadiness()(); // An unconfigured child/source host cannot overwrite the marker.
  assert.equal(readFileSync(path, "utf8"), first);
});
