import type { SkillContext, VoiceClientTimings } from "@palmagent/shared";
import { api } from "./api";
import { beginBrowserWork } from "./update-state";

export type VoiceState = "idle" | "starting" | "listening" | "stopping";
export const VOICE_METER_BARS = 17;
const elapsedMs = (start: number) => Math.round((performance.now() - start) * 10) / 10;

// Only one microphone per page. This also covers two mounted composers.
let current: VoiceInput | undefined;
export class VoiceInput {
  private closed = false;
  private finishing = false;
  private controller = new AbortController();
  private release = beginBrowserWork();
  private stream?: MediaStream;
  private audio?: AudioContext;
  private peer?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private id?: string;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private tick?: ReturnType<typeof setInterval>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private pending = "";
  private lastVoice = performance.now();
  private lastText = performance.now();
  private startedAt = 0;
  private firstVoiceAt?: number;
  private clientTimings: Partial<Omit<VoiceClientTimings, "outcome">> = {};
  private seen = new Set<string>();
  constructor(private context: SkillContext, private insert: (text: string) => void,
    private status: (state: VoiceState) => void, private error: (message: string) => void,
    private canInsert: () => boolean = () => true,
    private meter: (levels: number[]) => void = () => {}) {
    current?.cancel(); current = this;
  }

  async start() {
    this.startedAt = performance.now();
    this.status("starting");
    this.timers.push(setTimeout(() => this.fail("Voice input could not connect. Try again."), 25_000));
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection || !window.AudioContext) {
        throw new Error("Voice input needs HTTPS and a browser with microphone support.");
      }
      // Resume inside the button gesture for mobile audio policies.
      this.audio = new AudioContext();
      const audioResumeAt = performance.now();
      await this.audio.resume();
      this.clientTimings.audioContextResumeMs = elapsedMs(audioResumeAt);
      if (this.closed) return;
      const microphoneRequestAt = performance.now();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      this.clientTimings.microphoneRequestMs = elapsedMs(microphoneRequestAt);
      if (this.closed) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const peer = this.peer = new RTCPeerConnection();
      for (const track of stream.getTracks()) {
        peer.addTrack(track, stream);
        track.onended = () => { if (!this.finishing) this.fail("The microphone disconnected. Start it again."); };
      }
      const analyser = this.audio.createAnalyser(); analyser.fftSize = 1024;
      this.audio.createMediaStreamSource(stream).connect(analyser);
      const wave = new Float32Array(analyser.fftSize);
      const spectrum = new Uint8Array(analyser.frequencyBinCount);
      this.tick = setInterval(() => {
        if (!this.finishing) {
          analyser.getFloatTimeDomainData(wave);
          const hasSpectrum = spectrum.length > 0 && typeof analyser.getByteFrequencyData === "function";
          if (hasSpectrum) analyser.getByteFrequencyData(spectrum);
          const levels = Array.from({ length: VOICE_METER_BARS }, (_, index) => {
            if (hasSpectrum) {
              const maxBin = Math.max(VOICE_METER_BARS, Math.floor(spectrum.length * 0.6));
              const start = Math.floor((index / VOICE_METER_BARS) ** 2 * maxBin);
              const end = Math.min(maxBin, Math.max(start + 1, Math.floor(((index + 1) / VOICE_METER_BARS) ** 2 * maxBin)));
              let peak = 0;
              for (let bin = start; bin < end; bin++) peak = Math.max(peak, spectrum[bin]);
              return Math.max(0, Math.min(1, (peak - 24) / 170));
            }
            const start = Math.floor(index * wave.length / VOICE_METER_BARS);
            const end = Math.floor((index + 1) * wave.length / VOICE_METER_BARS);
            let energy = 0;
            for (let sample = start; sample < end; sample++) energy += wave[sample] * wave[sample];
            const rms = Math.sqrt(energy / Math.max(1, end - start));
            return Math.min(1, rms * 28);
          });
          this.meter(levels);
          const rms = Math.sqrt(wave.reduce((sum, value) => sum + value * value, 0) / wave.length);
          if (rms > 0.01) {
            const now = performance.now();
            this.firstVoiceAt ??= now;
            this.lastVoice = now;
          }
        }
        if (performance.now() - this.lastVoice >= 700 && performance.now() - this.lastText >= 800) this.flush();
      }, 50);
      const channel = this.channel = peer.createDataChannel("oai-events");
      channel.onopen = () => {
        if (this.closed || this.finishing) return;
        this.clientTimings.tapToReadyMs = elapsedMs(this.startedAt);
        clearTimeout(this.timers[0]); this.status("listening");
      };
      channel.onmessage = event => {
        if (this.closed) return;
        let msg: any; try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.type === "error" || msg.type === "session.ended") return this.fail("Voice input ended. Start the microphone again.");
        // V3 also sends turn deltas for the same words. Consume one source only.
        if (msg.type !== "input_transcript.added" || typeof msg.item?.text !== "string" || typeof msg.item.id !== "string") return;
        if (this.seen.has(msg.item.id)) return;
        if (this.seen.size >= 8192 || this.pending.length + msg.item.text.length > 32_000) return this.fail("Voice input reached its limit. Start the microphone again.");
        if (this.clientTimings.tapToFirstTranscriptMs === undefined) {
          this.clientTimings.tapToFirstTranscriptMs = elapsedMs(this.startedAt);
          if (this.firstVoiceAt !== undefined) {
            this.clientTimings.voiceToFirstTranscriptMs = Math.round((performance.now() - this.firstVoiceAt) * 10) / 10;
          }
        }
        this.seen.add(msg.item.id); this.pending += msg.item.text; this.lastText = performance.now();
      };
      channel.onclose = () => { if (!this.closed && !this.finishing) this.fail("Voice input disconnected. Start the microphone again."); };
      peer.onconnectionstatechange = () => {
        if (["failed", "disconnected", "closed"].includes(peer.connectionState) && !this.closed && !this.finishing) this.fail("Voice input disconnected. Start the microphone again.");
      };
      const localOfferAt = performance.now();
      await peer.setLocalDescription(await peer.createOffer());
      this.clientTimings.localOfferMs = elapsedMs(localOfferAt);
      if (this.closed) return;
      const serverRequestAt = performance.now();
      const result = await api.voice.start({ context: this.context, sdp: peer.localDescription!.sdp }, this.controller.signal);
      this.clientTimings.serverRequestMs = elapsedMs(serverRequestAt);
      if (this.closed) { void api.voice.stop(result.id, { outcome: "cancelled", ...this.clientTimings }).catch(() => {}); return; }
      this.id = result.id;
      const remoteDescriptionAt = performance.now();
      await peer.setRemoteDescription({ type: "answer", sdp: result.sdp });
      this.clientTimings.remoteDescriptionMs = elapsedMs(remoteDescriptionAt);
      if (this.closed) return;
      let checking = false;
      this.heartbeat = setInterval(() => {
        if (checking || this.closed) return;
        checking = true;
        void api.voice.heartbeat(result.id).catch(() => this.fail("Voice input ended. Start the microphone again.")).finally(() => { checking = false; });
      }, 10_000);
      this.timers.push(setTimeout(() => this.stop(), 9 * 60_000));
    } catch (error) {
      if (!this.closed) this.fail(error instanceof DOMException && error.name === "NotAllowedError"
        ? "Microphone access was denied. Allow it in your browser and try again."
        : error instanceof Error ? error.message : "Voice input could not start.");
    }
  }
  private flush() {
    if (this.closed || !this.canInsert()) return;
    const text = this.pending.trim(); this.pending = "";
    if (text) this.insert(text);
  }
  stop() {
    if (this.closed || this.finishing) return;
    if (!this.id || this.channel?.readyState !== "open") return this.cancel();
    this.finishing = true; this.status("stopping");
    this.stream?.getTracks().forEach(track => track.stop());
    // Keep the data channel briefly to receive the last words after mic release.
    this.timers.push(setTimeout(() => { this.flush(); this.cancel("completed"); }, 2000));
  }
  cancel(outcome: VoiceClientTimings["outcome"] = "cancelled") {
    if (this.closed) return;
    this.closed = true; this.controller.abort();
    this.timers.forEach(clearTimeout); clearInterval(this.tick); clearInterval(this.heartbeat);
    this.stream?.getTracks().forEach(track => track.stop());
    this.channel?.close(); this.peer?.close(); void this.audio?.close().catch(() => {});
    if (this.id) void api.voice.stop(this.id, { outcome, ...this.clientTimings }).catch(() => {});
    if (current === this) current = undefined;
    this.release(); this.meter(Array(VOICE_METER_BARS).fill(0)); this.status("idle");
  }
  private fail(message: string) {
    if (this.closed) return;
    this.flush(); this.cancel("failed"); this.error(message);
  }
}
