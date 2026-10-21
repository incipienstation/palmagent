import type { z } from "zod";
import { FILE_MEDIA_TYPE, INPUT_FILE_POLICY, INPUT_IMAGE_POLICY, type InputAttachment } from "@palmagent/shared";
import { ATTACHMENT_METADATA_FIELD, attachmentPartName } from "@palmagent/shared/http";
import { ApplicationError } from "../../../../kernel/errors.js";
import { jsonBody } from "../../../../platform/http/input.js";

/** Decode binary file parts at the HTTP boundary; services retain their input contract. */
export function attachmentBody<T extends z.ZodTypeAny>(schema: T): ReturnType<typeof jsonBody<T>> {
  const json = jsonBody(schema);
  return async (c, next) => {
    if (!c.req.header("content-type")?.toLowerCase().startsWith("multipart/form-data")) return json(c, next);
    const invalid = () => new ApplicationError("bad_request", "invalid attachment upload");
    let form: FormData;
    try { form = await c.req.raw.formData(); } catch { throw invalid(); }
    const metadata = form.getAll(ATTACHMENT_METADATA_FIELD);
    if (metadata.length !== 1 || typeof metadata[0] !== "string") throw invalid();
    let raw: unknown;
    try { raw = JSON.parse(metadata[0]); } catch { throw invalid(); }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw invalid();
    const input = parsed.data as { images?: InputAttachment[] };
    const markers = (raw as { images?: { binary?: unknown }[] }).images;
    if (!input.images || input.images.length > INPUT_IMAGE_POLICY.maxCount) throw invalid();
    const expected = new Set([ATTACHMENT_METADATA_FIELD]);
    const parts: { image: InputAttachment; blob: Blob }[] = [];
    let bytes = 0;
    for (const [index, image] of input.images.entries()) {
      if (markers?.[index]?.binary !== true) {
        bytes += image.data.length + (image.video?.frames.reduce((sum, frame) => sum + frame.image.data.length, 0) ?? 0);
        continue;
      }
      const key = attachmentPartName(index), values = form.getAll(key);
      expected.add(key);
      if (values.length !== 1 || typeof values[0] === "string" || !image.file || image.mediaType !== FILE_MEDIA_TYPE
        || image.data !== "" || image.video || image.width !== undefined || image.height !== undefined) throw invalid();
      const blob = values[0];
      if (blob.size > INPUT_FILE_POLICY.maxBytes) throw new ApplicationError("payload_too_large", "File exceeds attachment limit");
      bytes += Math.ceil(blob.size / 3) * 4;
      parts.push({ image, blob });
    }
    if (!parts.length || [...form.keys()].some(key => !expected.has(key))) throw invalid();
    if (bytes > INPUT_IMAGE_POLICY.maxWireBytes - 100_000) throw new ApplicationError("payload_too_large", "Attachments exceed request limit");
    // Validate the complete batch before allocating encoded service inputs.
    for (const { image, blob } of parts) image.data = Buffer.from(await blob.arrayBuffer()).toString("base64");
    c.req.addValidatedData("json", parsed.data);
    await next();
  };
}
