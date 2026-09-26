import { randomBytes } from "node:crypto";
import type { IdentifierGenerator } from "./application/ports.js";

/** Node-backed identifier generation for application use cases. */
export class NodeIdentifierGenerator implements IdentifierGenerator {
  next(prefix: string): string { return prefix + randomBytes(4).toString("hex"); }
}
