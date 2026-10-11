import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SkillContext } from "@palmagent/shared";
import { toast } from "sonner";
import { ShakeDetector } from "./shake-detector";
import { useShakeToDictate } from "./ShakeToDictateProvider";
import { closeVoiceAudioContext } from "./voice-audio-context";
import { VoiceInput, VOICE_METER_BARS, type VoiceState } from "./voice-input";

export function useVoiceInput(context: SkillContext | undefined, scope: string, disabled: boolean,
  insert: (text: string) => void, canInsert: () => boolean) {
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState("");
  const [meter, setMeter] = useState<number[]>(() => Array(VOICE_METER_BARS).fill(0));
  const session = useRef<VoiceInput | undefined>(undefined);
  const stateRef = useRef<VoiceState>("idle");
  const { enabled: shakeEnabled, reportSensorUnavailable } = useShakeToDictate();
  const callbacks = useRef({ insert, canInsert }); callbacks.current = { insert, canInsert };
  const toggle = useCallback(() => {
    if (stateRef.current !== "idle") { session.current?.stop(); return; }
    if (!context || disabled) return;
    setError("");
    const voice = new VoiceInput(context, text => callbacks.current.insert(text), next => {
      const previous = stateRef.current;
      stateRef.current = next;
      setState(next);
      if (previous === "stopping" && next === "idle") toast("Voice input finished");
    }, setError, () => callbacks.current.canInsert(), setMeter);
    session.current = voice;
    void voice.start();
  }, [context, disabled]);
  const toggleRef = useRef(toggle); toggleRef.current = toggle;
  const key = JSON.stringify(context);
  useLayoutEffect(() => {
    setError("");
    const leave = () => session.current?.cancel();
    const pagehide = (event: PageTransitionEvent) => { leave(); if (!event.persisted) closeVoiceAudioContext(); };
    const hide = () => { if (document.hidden) leave(); };
    window.addEventListener("pagehide", pagehide); document.addEventListener("visibilitychange", hide);
    return () => { leave(); window.removeEventListener("pagehide", pagehide); document.removeEventListener("visibilitychange", hide); };
  }, [key, scope, disabled]);
  useEffect(() => {
    if (!shakeEnabled || !context || disabled) return;
    const detector = new ShakeDetector();
    let listening = false;
    let hasMotionData = false;
    let sensorTimer = 0;
    const motion = (event: DeviceMotionEvent) => {
      if (stateRef.current === "stopping") return;
      const sample = event.acceleration ?? event.accelerationIncludingGravity;
      if (sample?.x != null && sample.y != null && sample.z != null
        && Number.isFinite(sample.x) && Number.isFinite(sample.y) && Number.isFinite(sample.z)) {
        hasMotionData = true;
        window.clearTimeout(sensorTimer);
      }
      if (document.visibilityState !== "visible" || !detector.update(event, performance.now())) return;
      const active = stateRef.current !== "idle";
      toast(active ? "Finishing voice input…" : "Voice input started");
      toggleRef.current();
    };
    const attach = () => {
      if (listening || document.visibilityState !== "visible") return;
      detector.reset();
      window.addEventListener("devicemotion", motion);
      hasMotionData = false;
      sensorTimer = window.setTimeout(() => {
        if (listening && !hasMotionData) reportSensorUnavailable();
      }, 5_000);
      listening = true;
    };
    const detach = () => {
      if (!listening) return;
      window.removeEventListener("devicemotion", motion);
      window.clearTimeout(sensorTimer);
      detector.reset();
      listening = false;
    };
    const syncListening = () => {
      if (document.visibilityState !== "visible" || document.querySelector('[role="dialog"][data-state="open"]')) {
        detach();
      } else {
        attach();
      }
    };
    const leave = () => detach();
    const resume = () => syncListening();
    const overlays = new MutationObserver(syncListening);
    overlays.observe(document.body, { attributes: true, attributeFilter: ["data-state"], childList: true, subtree: true });
    syncListening();
    document.addEventListener("visibilitychange", syncListening);
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", resume);
    return () => {
      detach();
      document.removeEventListener("visibilitychange", syncListening);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", resume);
      overlays.disconnect();
    };
  }, [shakeEnabled, context, disabled, reportSensorUnavailable]);
  return { state, error, meter, active: state !== "idle", cancel: () => session.current?.cancel(), toggle };
}
