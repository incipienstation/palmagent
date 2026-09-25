class PalmagentVoiceBuffer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const maxSeconds = options.processorOptions?.maxSeconds ?? 27;
    this.capacity = Math.ceil(sampleRate * maxSeconds);
    this.samples = new Float32Array(this.capacity);
    this.read = 0;
    this.write = 0;
    this.length = 0;
    this.started = false;
    this.finished = false;
    this.cancelled = false;
    this.overflowed = false;
    this.drained = false;
    this.port.onmessage = event => {
      if (event.data?.type === "start") this.started = true;
      if (event.data?.type === "finish") this.finished = true;
      if (event.data?.type === "cancel") {
        this.cancelled = true;
        this.finished = true;
        this.length = 0;
        this.read = this.write;
      }
    };
  }

  push(sample) {
    if (this.length >= this.capacity) return false;
    this.samples[this.write] = sample;
    this.write = (this.write + 1) % this.capacity;
    this.length++;
    return true;
  }

  pop() {
    const sample = this.samples[this.read];
    this.read = (this.read + 1) % this.capacity;
    this.length--;
    return sample;
  }

  process(inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;
    output.fill(0);
    const input = inputs[0] ?? [];
    const frames = input[0]?.length ?? output.length;

    if (!this.started && !this.finished && !this.cancelled) {
      for (let frame = 0; frame < frames; frame++) {
        let sample = 0;
        for (const channel of input) sample += channel[frame] ?? 0;
        if (input.length) sample /= input.length;
        if (!this.push(sample)) {
          if (!this.overflowed) {
            this.overflowed = true;
            this.port.postMessage({ type: "overflow" });
          }
          break;
        }
      }
    } else if (this.started && !this.cancelled) {
      for (let frame = 0; frame < output.length; frame++) {
        if (this.length > 0) {
          output[frame] = this.pop();
          if (!this.finished && input.length) {
            let sample = 0;
            for (const channel of input) sample += channel[frame] ?? 0;
            if (!this.push(sample / input.length) && !this.overflowed) {
              this.overflowed = true;
              this.port.postMessage({ type: "overflow" });
            }
          }
        } else if (!this.finished && input.length) {
          let sample = 0;
          for (const channel of input) sample += channel[frame] ?? 0;
          output[frame] = sample / input.length;
        }
      }
    }

    if (this.started && this.finished && this.length === 0 && !this.drained && !this.cancelled) {
      this.drained = true;
      this.port.postMessage({ type: "drained" });
    }
    return true;
  }
}

registerProcessor("palmagent-voice-buffer", PalmagentVoiceBuffer);
