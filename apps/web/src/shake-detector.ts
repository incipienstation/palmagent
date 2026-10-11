const SHAKE_THRESHOLD = 2.2;
const SHAKE_RELEASE = 1.25;
const MIN_PEAK_INTERVAL_MS = 70;
const PEAK_WINDOW_MS = 1_000;
const REQUIRED_PEAKS = 3;
const QUIET_REARM_MS = 500;

/** Detect three distinct acceleration peaks, then wait for stillness before rearming. */
export class ShakeDetector {
  private baseline?: [number, number, number];
  private aboveThreshold = false;
  private peaks: number[] = [];
  private lastPeak?: number;
  private triggered = false;
  private quietSince = 0;

  update(event: Pick<DeviceMotionEvent, "acceleration" | "accelerationIncludingGravity">, now: number): boolean {
    let sample = event.acceleration;
    if (!sample || sample.x == null || sample.y == null || sample.z == null) sample = event.accelerationIncludingGravity;
    if (!sample || sample.x == null || sample.y == null || sample.z == null
      || !Number.isFinite(sample.x) || !Number.isFinite(sample.y) || !Number.isFinite(sample.z)) return false;
    const values: [number, number, number] = [sample.x, sample.y, sample.z];
    if (!values.every(Number.isFinite)) return false;

    if (!this.baseline) {
      this.baseline = values;
      return false;
    }

    const dynamic = values.map((value, index) => {
      const previous = this.baseline![index];
      this.baseline![index] = previous * 0.92 + value * 0.08;
      return value - previous;
    });
    const strength = Math.hypot(...dynamic);

    if (this.triggered) {
      if (strength < SHAKE_RELEASE) {
        this.quietSince ||= now;
        if (now - this.quietSince >= QUIET_REARM_MS) {
          this.triggered = false;
          this.aboveThreshold = false;
          this.peaks = [];
        }
      } else {
        this.quietSince = 0;
      }
      return false;
    }

    this.peaks = this.peaks.filter(time => now - time <= PEAK_WINDOW_MS);
    if (strength < SHAKE_RELEASE) this.aboveThreshold = false;
    if (strength < SHAKE_THRESHOLD || this.aboveThreshold) return false;
    this.aboveThreshold = true;

    if (this.lastPeak !== undefined && now - this.lastPeak < MIN_PEAK_INTERVAL_MS) return false;
    this.lastPeak = now;
    this.peaks.push(now);
    if (this.peaks.length < REQUIRED_PEAKS || now - this.peaks[0] < 160) return false;

    this.triggered = true;
    this.quietSince = 0;
    return true;
  }

  reset() {
    this.baseline = undefined;
    this.aboveThreshold = false;
    this.peaks = [];
    this.lastPeak = undefined;
    this.triggered = false;
    this.quietSince = 0;
  }
}
