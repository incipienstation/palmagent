type Cleanup = () => void | Promise<void>;

/** Stop admission first, then release acquired resources in reverse order. */
export class ResourceScope {
  private stops: Cleanup[] = [];
  private releases: Cleanup[] = [];
  private closing?: Promise<void>;

  onStop(cleanup: Cleanup): void { this.stops.push(cleanup); }
  defer(cleanup: Cleanup): void { this.releases.push(cleanup); }

  close(): Promise<void> {
    return this.closing ??= this.dispose();
  }

  private async dispose(): Promise<void> {
    const errors: unknown[] = [];
    for (const cleanup of [...this.stops, ...this.releases.reverse()]) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    this.stops = []; this.releases = [];
    if (errors.length) throw new AggregateError(errors, "Resource cleanup failed");
  }

  async fail(error: unknown): Promise<never> {
    try { await this.close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Operation and cleanup failed"); }
    throw error;
  }
}
