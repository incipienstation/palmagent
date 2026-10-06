/** Portable entropy and content identity contract supplied by the runtime. */
export interface IdentifierGenerator {
  next(prefix: string): string;
  uuid(): string;
  digest(value: string): string;
}
