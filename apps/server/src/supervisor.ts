import type { RunHandle } from "./types.js";

// Owns process lifetime: a child is held ONLY while a turn runs (the adapters
// keep "process = one turn → idle", incl. Claude's stdin-close). Enforces the
// concurrency cap with a counting semaphore — overflow turns wait until a slot
// frees, which is how a task sits in `queued`.
export class ProcessSupervisor {
  private handles = new Map<string, RunHandle>();
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  // Take a slot without waiting; true if one was free.
  tryAcquire(): boolean {
    if (this.active < this.max) {
      this.active++;
      return true;
    }
    return false;
  }

  // Wait for a slot. Resolves immediately if one is free, else when a running
  // turn releases (the slot is handed off directly — no double counting).
  acquire(): Promise<void> {
    return new Promise((resolve) => {
      if (this.active < this.max) {
        this.active++;
        resolve();
      } else {
        this.waiters.push(resolve);
      }
    });
  }

  register(taskId: string, handle: RunHandle): void {
    this.handles.set(taskId, handle);
  }
  // Restart recovery: a turn still alive in the runner daemon was already holding
  // a slot before we restarted, so take the slot unconditionally (it may push
  // `active` to the cap, which is correct — these turns are genuinely running)
  // and register its reattached handle.
  reclaim(taskId: string, handle: RunHandle): void {
    this.active++;
    this.handles.set(taskId, handle);
  }
  get(taskId: string): RunHandle | undefined {
    return this.handles.get(taskId);
  }
  has(taskId: string): boolean {
    return this.handles.has(taskId);
  }

  // Drop the handle and free the slot, handing it to the next queued waiter.
  release(taskId: string): void {
    this.handles.delete(taskId);
    const next = this.waiters.shift();
    if (next) next();
    else if (this.active > 0) this.active--;
  }

  get inUse(): number {
    return this.active;
  }
}
