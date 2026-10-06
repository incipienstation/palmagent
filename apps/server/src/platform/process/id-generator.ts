import { randomBytes, randomUUID, createHash } from "node:crypto";
import type { IdentifierGenerator } from "../../kernel/identifiers.js";

/** Node-backed identifier generation for application use cases. */
export class NodeIdentifierGenerator implements IdentifierGenerator {
  uuid(): string { return randomUUID(); }
  digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
  next(prefix: string): string { return prefix + randomBytes(4).toString("hex"); }
}
