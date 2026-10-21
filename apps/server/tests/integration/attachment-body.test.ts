import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { SubmitMessageSchema } from "@palmagent/shared";
import { attachmentBody } from "../../src/modules/tasks/adapters/inbound/attachment-body.js";
import { handleError } from "../../src/platform/http/errors.js";

const file = { mediaType: "application/octet-stream", data: "", file: { name: "notes.bin" }, binary: true };
const request = { mode: "queue", text: "Read", clientMessageId: "11111111-1111-4111-8111-111111111111", expectedRunId: null, images: [file] };
function form(input: unknown = request) {
  const body = new FormData();
  body.set("request", JSON.stringify(input));
  body.set("attachment-0", new Blob([new Uint8Array([0, 255, 128, 1])]), "notes.bin");
  return body;
}

test("multipart reconstructs exact bytes and preserves the legacy JSON contract", async () => {
  const app = new Hono().onError(handleError).post("/", attachmentBody(SubmitMessageSchema), c => c.json(c.req.valid("json")));
  const uploaded = await app.request("/", { method: "POST", body: form() });
  assert.equal(uploaded.status, 200);
  const decoded = await uploaded.json();
  assert.equal(decoded.images[0].data, "AP+AAQ==");
  assert.equal(decoded.clientMessageId, request.clientMessageId);
  assert.equal(decoded.images[0].binary, undefined);
  const legacy = await app.request("/", { method: "POST", body: JSON.stringify(decoded) });
  assert.deepEqual(await legacy.json(), decoded);
});

test("multipart rejects malformed, missing, duplicate, unexpected and misbound parts before mutation", async () => {
  let mutations = 0;
  const app = new Hono().onError(handleError).post("/", attachmentBody(SubmitMessageSchema), c => { mutations++; return c.json({}); });
  const invalid: FormData[] = [];
  const add = (change: (body: FormData) => void) => { const body = form(); change(body); invalid.push(body); };
  add(body => body.delete("attachment-0"));
  add(body => body.append("attachment-0", new Blob(["duplicate"])));
  add(body => body.set("attachment-1", new Blob(["extra"])));
  add(body => body.set("extra", "unbound"));
  add(body => body.set("attachment-0", "not a file"));
  add(body => body.append("request", JSON.stringify(request)));
  add(body => body.set("request", "{"));
  add(body => body.set("request", "null"));
  for (const image of [{ ...file, binary: false }, { ...file, data: "YQ==" }, { ...file, mediaType: "image/png" },
    { ...file, file: { name: "../escape" } }, { ...file, width: 1, height: 1 }]) invalid.push(form({ ...request, images: [image] }));
  invalid.push(form({ ...request, images: Array(9).fill(file) }));
  for (const body of invalid) assert.equal((await app.request("/", { method: "POST", body })).status, 400);
  assert.equal(mutations, 0);
});

test("oversized binary parts are rejected before reading or encoding their bytes", async () => {
  const app = new Hono().onError(handleError).post("/", attachmentBody(SubmitMessageSchema), c => c.json({}));
  const body = form();
  const blob = body.get("attachment-0") as File;
  Object.defineProperty(blob, "size", { value: 256 * 1024 * 1024 + 1 });
  blob.arrayBuffer = async () => { throw new Error("Must not read oversized bytes"); };
  const req = new Request("http://localhost/", { method: "POST", body: "placeholder", headers: { "content-type": "multipart/form-data; boundary=fixture" } });
  req.formData = async () => body;
  const response = await app.fetch(req);
  assert.equal(response.status, 413);
});
