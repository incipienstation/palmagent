import { createHash, createPublicKey, verify } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, posix } from "node:path";
import { list, extract } from "tar";

export const MAX_RELEASE_DOCUMENT_BYTES = 2 * 1024 * 1024;

export function sha256File(path: string): string {
  const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
  const fd = openSync(path, "r");
  try {
    let count: number;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
  } finally { closeSync(fd); }
  return hash.digest("hex");
}

/** Verify bytes before parsing the payload. The caller validates its wire schema. */
export function verifySignedPayload(bytes: Uint8Array, keys: Readonly<Record<string, string>>): unknown {
  if (bytes.byteLength > MAX_RELEASE_DOCUMENT_BYTES) throw new Error("Release document exceeds the size limit");
  const envelope = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (envelope?.schemaVersion !== 1 || typeof envelope.payload !== "string" ||
      !Array.isArray(envelope.signatures) || envelope.signatures.length < 1 || envelope.signatures.length > 8)
    throw new Error("Invalid signed release document");
  const payload = Buffer.from(envelope.payload, "base64");
  if (!payload.length || payload.toString("base64") !== envelope.payload) throw new Error("Invalid release payload encoding");
  const accepted = envelope.signatures.some((entry: { keyId?: unknown; signature?: unknown }) => {
    if (typeof entry?.keyId !== "string" || !Object.hasOwn(keys, entry.keyId) || typeof entry.signature !== "string") return false;
    const signature = Buffer.from(entry.signature, "base64");
    if (signature.length !== 64 || signature.toString("base64") !== entry.signature) return false;
    const key = createPublicKey(keys[entry.keyId]);
    return key.asymmetricKeyType === "ed25519" && verify(null, payload, key, signature);
  });
  if (!accepted) throw new Error("Release signature is not trusted");
  return JSON.parse(payload.toString("utf8"));
}

/** Standalone archives contain only ordinary files and directories under palmagent/. */
export function inspectReleaseArchive(file: string, expectedSize: number, maxUnpackedSize: number): void {
  if (statSync(file).size !== expectedSize) throw new Error("Release archive size differs from the manifest");
  const names = new Set<string>();
  let unpacked = 0;
  list({ file, sync: true, strict: true, onReadEntry(entry) {
    const path = entry.path.replace(/\/$/, "");
    if (!path || isAbsolute(path) || /[\\\x00-\x1f\x7f]/.test(path) || posix.normalize(path) !== path ||
        !(path === "palmagent" || path.startsWith("palmagent/")) || path.split("/").includes("..") ||
        !["File", "Directory"].includes(entry.type) || (entry.mode !== undefined && (entry.mode & 0o6000) !== 0))
      throw new Error("Unsafe entry in release archive");
    if (names.has(path) || names.size >= 100_000) throw new Error("Duplicate or excessive release archive entries");
    names.add(path);
    unpacked += entry.size;
    if (!Number.isSafeInteger(unpacked) || unpacked > maxUnpackedSize) throw new Error("Release archive exceeds its unpacked size limit");
  } });
  if (!names.has("palmagent/runtime/bin/node") || !names.has("palmagent/app/package.json") || !names.has("palmagent/bundle.json"))
    throw new Error("Release archive is incomplete");
}

/** Destination must be a new private directory owned by the caller. */
export function extractReleaseArchive(file: string, destination: string, size: number, unpackedSize: number): void {
  inspectReleaseArchive(file, size, unpackedSize);
  extract({ file, cwd: destination, sync: true, strict: true, preserveOwner: false, chmod: true,
    filter: (_path, entry) => "type" in entry && (entry.type === "File" || entry.type === "Directory") });
}
