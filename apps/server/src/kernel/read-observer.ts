/** Share source refreshes across subscribers. Timers exist only while observed. */
export class ReadObserver<T> {
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private dirty = false;
  private previous?: string;
  constructor(private read: () => Promise<T>, private delay: () => number,
    private fingerprint: (value: T) => string = JSON.stringify) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    // Every connection needs a fresh read, including reconnects that missed events.
    listener();
    this.refresh();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) { clearTimeout(this.timer); this.timer = undefined; }
    };
  }

  refresh(): void {
    if (!this.listeners.size) return;
    clearTimeout(this.timer);
    if (this.pending) { this.dirty = true; return; }
    this.pending = (async () => {
      let next: string;
      try { next = this.fingerprint(await this.read()); }
      catch { next = "read-failed"; }
      if (next !== this.previous) {
        this.previous = next;
        for (const listener of this.listeners) listener();
      }
    })().finally(() => {
      this.pending = undefined;
      if (!this.listeners.size) return;
      if (this.dirty) { this.dirty = false; this.refresh(); }
      else { this.timer = setTimeout(() => this.refresh(), Math.max(1, this.delay())); this.timer.unref(); }
    });
  }

  close(): void { this.listeners.clear(); clearTimeout(this.timer); }
  get observed(): boolean { return this.listeners.size > 0; }
}
