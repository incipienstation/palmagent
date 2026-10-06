export interface RetainedRuntime {
  state: string; protocol: number; node: string; release: string;
}
export interface RuntimeInventory {
  terminals(directory: string): { list(): RetainedRuntime[]; close(): void };
  executions(directory: string): { list(): RetainedRuntime[]; close(): void };
}
