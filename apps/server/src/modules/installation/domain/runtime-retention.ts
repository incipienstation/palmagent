/** Installation policy works on facts gathered by host adapters. */
export interface RuntimeFacts { state: string; protocol: number; artifactsAvailable: boolean }
export function activeTerminal(state: string): boolean { return ["starting", "running", "closing"].includes(state); }
export function activeExecution(state: string): boolean { return ["queued", "starting", "running"].includes(state); }
export function verifyRetainedTerminal(record: RuntimeFacts, protocol: number | undefined): void {
  if (activeTerminal(record.state) && (protocol !== 1 || record.protocol !== protocol || !record.artifactsAvailable)) throw new Error("Candidate cannot control a retained terminal");
}
export function verifyRetainedExecution(record: RuntimeFacts, protocol: number): void {
  if (record.protocol !== protocol) throw new Error("Candidate cannot replay or control a retained execution");
  if (activeExecution(record.state) && !record.artifactsAvailable) throw new Error("An active execution artifact is unavailable");
}
