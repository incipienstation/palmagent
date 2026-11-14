/** The queue owns cancellation; composition supplies the clock and scheduler. */
export interface MessageTiming {
  now(): number;
  every(intervalMs: number, callback: () => void): () => void;
}
