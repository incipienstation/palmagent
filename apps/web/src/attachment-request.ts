import type { InputAttachment } from "@palmagent/shared";
import { ATTACHMENT_METADATA_FIELD, attachmentPartName } from "@palmagent/shared/http";
import { attachmentBlob } from "./images";

/** Freeze mutable metadata, retaining immutable strings and native Blob handles. */
export function snapshotRequest<T extends object>(input: T): T {
  const { images, ...rest } = input as T & { images?: InputAttachment[] };
  return { ...structuredClone(rest), ...(images ? { images: images.map(image => {
    const { data, ...metadata } = image;
    return { ...structuredClone(metadata), data };
  }) } : {}) } as T;
}

// Hono still owns endpoint paths and response inference. Its JSON argument is
// small metadata; replace the body at fetch time so the browser streams files.
export function attachmentFetch(input: object, fetcher: typeof fetch): typeof fetch | undefined {
  const images = (input as { images?: InputAttachment[] }).images;
  if (!images?.some(attachmentBlob)) return undefined;
  return (url, init) => {
    const body = new FormData();
    body.set(ATTACHMENT_METADATA_FIELD, JSON.stringify({ ...input, images: images.map(image => {
      const { blob, ...metadata } = image as InputAttachment & { blob?: Blob };
      return { ...metadata, ...(blob ? { binary: true } : {}) };
    }) }));
    images.forEach((image, index) => {
      const blob = attachmentBlob(image);
      if (blob) body.set(attachmentPartName(index), blob, image.file?.name ?? "attachment");
    });
    const headers = new Headers(init?.headers);
    headers.delete("content-type");
    return fetcher(url, { ...init, body, headers, cache: "no-store" });
  };
}
