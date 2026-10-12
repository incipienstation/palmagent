const SHAKE_THRESHOLD_MPS2 = 16; // App-tuned cutoff; sensor APIs do not define a universal shake threshold.
const SHAKE_RELEASE_MPS2 = 8; // Lower reset point provides hysteresis.
const MIN_PEAK_INTERVAL_MS = 120;
const PEAK_WINDOW_MS = 900;
const REQUIRED_PEAKS = 3;
const MIN_PEAK_SPAN_MS = 240;
const QUIET_REARM_MS = 900;
const GRAVITY_FILTER_TIME_CONSTANT_MS = 200;

/** Detect three strong, distinct linear-acceleration peaks; rearm only after a quiet pause. */
export class ShakeDetector {
  private gravity?: [number, number, number];
  private lastSampleAt?: number;
  private aboveThreshold = false;
  private peaks: number[] = [];
  private lastPeak?: number;
  private triggered = false;
  private quietSince = 0;

  update(event: Pick<DeviceMotionEvent, "acceleration" | "accelerationIncludingGravity">, now: number): boolean {
    const linear = event.acceleration;
    let strength: number;
    if (linear && linear.x != null && linear.y != null && linear.z != null
      && Number.isFinite(linear.x) && Number.isFinite(linear.y) && Number.isFinite(linear.z)) {
      // DeviceMotionEvent.acceleration is linear acceleration (gravity removed).
      strength = Math.hypot(linear.x, linear.y, linear.z);
    } else {
      const sample = event.accelerationIncludingGravity;
      if (!sample || sample.x == null || sample.y == null || sample.z == null
        || !Number.isFinite(sample.x) || !Number.isFinite(sample.y) || !Number.isFinite(sample.z)) return false;

      const values: [number, number, number] = [sample.x, sample.y, sample.z];
      if (!this.gravity) {
        this.gravity = values;
        this.lastSampleAt = now;
        return false;
      }

      const elapsed = this.lastSampleAt === undefined ? 16 : Math.max(1, Math.min(now - this.lastSampleAt, 250));
      this.lastSampleAt = now;
      const alpha = GRAVITY_FILTER_TIME_CONSTANT_MS / (GRAVITY_FILTER_TIME_CONSTANT_MS + elapsed);
      const dynamic = values.map((value, index) => {
        const previous = this.gravity![index];
        this.gravity![index] = alpha * previous + (1 - alpha) * value;
        return value - previous;
      });
      strength = Math.hypot(...dynamic);
    }

    if (!Number.isFinite(strength)) return false;

    if (this.triggered) {
      if (strength < SHAKE_RELEASE_MPS2) {
        this.quietSince ||= now;
        if (now - this.quietSince >= QUIET_REARM_MS) {
          this.triggered = false;
          this.aboveThreshold = false;
          this.peaks = [];
          this.lastPeak = undefined;
        }
      } else {
        this.quietSince = 0;
      }
      return false;
    }

    this.peaks = this.peaks.filter(time => now - time <= PEAK_WINDOW_MS);
    if (strength < SHAKE_RELEASE_MPS2) this.aboveThreshold = false;
    if (strength < SHAKE_THRESHOLD_MPS2 || this.aboveThreshold) return false;
    this.aboveThreshold = true;

    if (this.lastPeak !== undefined && now - this.lastPeak < MIN_PEAK_INTERVAL_MS) return false;
    this.lastPeak = now;
    this.peaks.push(now);
    if (this.peaks.length < REQUIRED_PEAKS || now - this.peaks[0] < MIN_PEAK_SPAN_MS) return false;

    this.triggered = true;
    this.quietSince = 0;
    return true;
  }

  reset() {
    this.gravity = undefined;
    this.lastSampleAt = undefined;
    this.aboveThreshold = false;
    this.peaks = [];
    this.lastPeak = undefined;
    this.triggered = false;
    this.quietSince = 0;
  }
}
