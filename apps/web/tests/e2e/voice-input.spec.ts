import { test, expect, type Page } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";

async function microphone(page: Page, mode = "ok", delayStart = false) {
  await page.addInitScript(mode => {
    const state: any = (window as any).voiceTest = { speaking: false, stopped: 0, closed: 0, audioClosed: 0, workletMessages: [] };
    const track = { stop: () => state.stopped++, onended: null };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: () => {
      if (mode === "denied") return Promise.reject(new DOMException("denied", "NotAllowedError"));
      if (mode === "pending") return new Promise(resolve => { state.allow = () => resolve(stream); });
      return Promise.resolve(stream);
    } } });
    (window as any).AudioContext = class {
      resume() { return Promise.resolve(); }
      close() { state.audioClosed++; return Promise.resolve(); }
      createMediaStreamSource() { return { connect() {} }; }
      createMediaStreamDestination() { return { stream: { getAudioTracks: () => [{ stop() {}, onended: null }] } }; }
      audioWorklet = { addModule: () => Promise.resolve() };
      createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData(array: Float32Array) { array.fill(state.speaking ? 0.04 : 0); } }; }
    };
    (window as any).AudioWorkletNode = class {
      port: any;
      constructor() {
        let started = false, finished = false, drained = false;
        this.port = {
          onmessage: null,
          close() {},
          postMessage: (message: any) => {
            state.workletMessages.push(message.type);
            if (message.type === "start") started = true;
            if (message.type === "finish") finished = true;
            if (message.type === "cancel") return;
            if (started && finished && !drained) {
              drained = true;
              queueMicrotask(() => this.port.onmessage?.({ data: { type: "drained" } }));
            }
          },
        };
        state.worklet = this;
      }
      connect() {}
      disconnect() {}
    };
    (window as any).RTCPeerConnection = class {
      connectionState = "new"; localDescription: any; onconnectionstatechange?: () => void;
      channel: any = { readyState: "connecting", close() { this.readyState = "closed"; this.onclose?.(); } };
      constructor() { state.peer = this; }
      addTrack() {}
      createDataChannel() { state.channel = this.channel; return this.channel; }
      createOffer() { return Promise.resolve({ type: "offer", sdp: "v=0\r\noffer" }); }
      setLocalDescription(value: any) { this.localDescription = value; return Promise.resolve(); }
      setRemoteDescription() {
        this.connectionState = "connected"; this.channel.readyState = "open";
        this.channel.onopen?.(); return Promise.resolve();
      }
      close() { state.closed++; this.connectionState = "closed"; this.onconnectionstatechange?.(); }
    };
    state.emit = (id: string, text: string) => state.channel.onmessage({ data: JSON.stringify({ type: "input_transcript.added", item: { id, text } }) });
  }, mode);
  let starts = 0, stops = 0, allowStart: (() => void) | undefined; const stopBodies: any[] = [];
  const startGate = delayStart ? new Promise<void>(resolve => { allowStart = resolve; }) : Promise.resolve();
  await page.route("**/api/voice", async route => { starts++; await startGate; await route.fulfill({ json: { id: "11111111-1111-4111-8111-111111111111", sdp: "v=0\r\nanswer" } }); });
  await page.route("**/api/voice/*", async route => {
    stops++;
    if (route.request().method() === "DELETE") stopBodies.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true } });
  });
  return { starts: () => starts, stops: () => stops, stopBodies: () => stopBodies, allowStart: () => allowStart?.() };
}

for (const width of [360, 1280]) test(`Codex alone shows microphone beside Send at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 780 });
  await page.goto("/#/task/t-idle-rich");
  await expect(page.getByRole("button", { name: "Start voice input" })).toHaveCount(0);
  await page.goto("/#/task/t-idle-interrupted");
  const mic = page.getByRole("button", { name: "Start voice input" });
  await expect(mic).toBeInViewport({ ratio: 1 });
  const a = await mic.boundingBox(), b = await page.getByRole("button", { name: "Send now", exact: true }).boundingBox();
  expect(a!.width).toBeGreaterThanOrEqual(44);
  expect(b!.x - a!.x - a!.width).toBeLessThanOrEqual(8);
  expect(Math.abs(a!.y - b!.y)).toBeLessThanOrEqual(1);
  await assertViewportLocked(page);
});

test("speech waits for silence, preserves edits, deduplicates and never submits", async ({ page }) => {
  const calls = await microphone(page); let submissions = 0;
  page.on("request", r => { if (r.method() === "POST" && r.url().endsWith("/messages")) submissions++; });
  await page.goto("/#/task/t-idle-interrupted");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Original draft");
  await page.getByRole("button", { name: "Start voice input" }).click();
  await expect(page.getByText("Recording… tap the microphone to finish.")).toBeVisible();
  await page.evaluate(() => { const v = (window as any).voiceTest; v.speaking = true; v.emit("one", " Hello"); v.emit("one", " Hello"); });
  await input.fill("Edited while listening");
  await page.waitForTimeout(1100);
  await expect(input).toHaveValue("Edited while listening");
  await input.press("Control+Enter"); expect(submissions).toBe(0);
  await page.evaluate(() => { const v = (window as any).voiceTest; v.emit("two", " world."); v.speaking = false; });
  await expect(input).toHaveValue("Edited while listening Hello world.");
  await expect(page.getByRole("button", { name: "Send now", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Stop voice input" }).click();
  await expect(page.getByText("Finishing transcription…")).toBeVisible();
  // The data channel remains open while buffered audio and its final words drain.
  await page.evaluate(() => (window as any).voiceTest.emit("three", " One more."));
  await expect(input).toHaveValue("Edited while listening Hello world. One more.");
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.stopped)).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Start voice input" })).toBeVisible();
  await expect(input).toHaveValue("Edited while listening Hello world. One more.");
  await expect(page.getByRole("button", { name: "Send now", exact: true })).toBeEnabled();
  expect(calls.starts()).toBe(1); await expect.poll(calls.stops).toBe(1); expect(submissions).toBe(0);
  const timing = calls.stopBodies()[0]?.timings;
  expect(timing?.outcome).toBe("completed");
  expect(typeof timing?.serverRequestMs).toBe("number");
  expect(typeof timing?.tapToReadyMs).toBe("number");
  expect(typeof timing?.tapToFirstTranscriptMs).toBe("number");
  expect(timing).not.toHaveProperty("transcript");
});

test("recording starts before connection and stop drains the client buffer", async ({ page }) => {
  const calls = await microphone(page, "ok", true);
  await page.goto("/#/task/t-idle-interrupted");
  const start = page.getByRole("button", { name: "Start voice input" });
  await start.click();
  await expect(page.getByText("Recording… tap the microphone to finish.")).toBeVisible();
  const stop = page.getByRole("button", { name: "Stop voice input" });
  await expect(stop).toHaveAttribute("aria-pressed", "true");
  await expect.poll(calls.starts).toBe(1);
  await stop.click();
  await expect(page.getByText("Finishing transcription…")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.workletMessages.join(","))).toBe("finish");

  calls.allowStart();
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.workletMessages.join(","))).toBe("finish,start");
  await expect.poll(calls.stops).toBe(1);
  await expect(page.getByRole("button", { name: "Start voice input" })).toBeVisible();
});

test("audio worklet holds input silently until ready, then replays and drains it", async ({ page }) => {
  await page.goto("/#/task/t-idle-interrupted");
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.textContent = "Start audio buffer check";
    button.addEventListener("click", () => {
      (window as any).voiceBufferResult = (async () => {
        const audio = new AudioContext();
        await audio.resume();
        await audio.audioWorklet.addModule("/voice-buffer-worklet.js");
        const buffer = new AudioWorkletNode(audio, "palmagent-voice-buffer", {
          numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1,
          channelCountMode: "explicit", outputChannelCount: [1], processorOptions: { maxSeconds: 1 },
        });
        const source = audio.createConstantSource(); source.offset.value = 0.25;
        const meter = audio.createAnalyser(); meter.fftSize = 256;
        buffer.connect(meter); meter.connect(audio.destination); source.connect(buffer); source.start();
        const rms = () => {
          const samples = new Float32Array(meter.fftSize);
          meter.getFloatTimeDomainData(samples);
          return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
        };
        await new Promise(resolve => setTimeout(resolve, 120));
        const beforeReadyRms = rms();
        const drained = new Promise<boolean>(resolve => {
          buffer.port.onmessage = event => { if (event.data?.type === "drained") resolve(true); };
        });
        buffer.port.postMessage({ type: "start" });
        await new Promise(resolve => setTimeout(resolve, 120));
        const afterReadyRms = rms();
        buffer.port.postMessage({ type: "finish" }); source.stop();
        const didDrain = await Promise.race([drained, new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2000))]);
        await audio.close();
        return { beforeReadyRms, afterReadyRms, didDrain };
      })();
    }, { once: true });
    document.body.append(button);
  });
  await page.getByRole("button", { name: "Start audio buffer check" }).click();
  const result = await page.evaluate(async () => await (window as any).voiceBufferResult);
  expect(result.beforeReadyRms).toBeLessThan(0.001);
  expect(result.afterReadyRms).toBeGreaterThan(0.1);
  expect(result.didDrain).toBe(true);
});

test("permission rejection preserves the draft and returns the microphone to idle", async ({ page }) => {
  const calls = await microphone(page, "denied");
  await page.goto("/#/task/t-idle-interrupted");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Keep me");
  await page.getByRole("button", { name: "Start voice input" }).click();
  await expect(page.getByRole("alert")).toContainText("Microphone access was denied");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Keep me");
  await expect(page.getByRole("button", { name: "Start voice input" })).toBeEnabled();
  expect(calls.starts()).toBe(0);
});

test("cancelling while permission is pending releases a later microphone grant", async ({ page }) => {
  const calls = await microphone(page, "pending");
  await page.goto("/#/task/t-idle-interrupted");
  await page.getByRole("button", { name: "Start voice input" }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).voiceTest.allow)).toBe("function");
  await page.getByRole("button", { name: "Stop voice input" }).click();
  await page.evaluate(() => (window as any).voiceTest.allow());
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.stopped)).toBeGreaterThan(0);
  expect(calls.starts()).toBe(0);
});

test("settings disappear during dictation and return after it ends", async ({ page }) => {
  const calls = await microphone(page);
  await page.goto("/#/new");
  const configure = page.getByRole("button", { name: "Configure task settings" });
  await configure.click(); await page.getByRole("radio", { name: "codex", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("Keep my draft");
  await page.getByRole("button", { name: "Start voice input" }).click();
  await expect(page.getByText("Recording… tap the microphone to finish.")).toBeVisible();
  await expect(configure).toHaveCount(0);
  await page.getByRole("button", { name: "Stop voice input" }).click();
  await expect.poll(calls.stops).toBe(1);
  await expect(configure).toBeVisible();
  await page.evaluate(() => (window as any).voiceTest.emit("late", "Do not append"));
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("Keep my draft");
  await configure.click(); await page.getByRole("radio", { name: "claude", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start voice input" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("Keep my draft");
});
