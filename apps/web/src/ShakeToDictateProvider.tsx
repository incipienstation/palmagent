import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { closeVoiceAudioContext, getVoiceAudioContext, retainVoiceAudioContext } from "./voice-audio-context";

const STORAGE_KEY = "pref:shake-to-dictate";
type SetupStatus = "idle" | "requesting" | "ready" | "unsupported" | "denied";
type ShakeToDictateContextValue = {
  enabled: boolean;
  status: SetupStatus;
  error: string;
  reportSensorUnavailable: () => void;
  setEnabled: (enabled: boolean) => Promise<void>;
};

const Context = createContext<ShakeToDictateContextValue | null>(null);

function readInitial(): boolean {
  try { return window.localStorage.getItem(STORAGE_KEY) === "on"; }
  catch { return false; }
}

function savePreference(enabled: boolean) {
  try { window.localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off"); }
  catch { /* The setting still applies until this page closes. */ }
}

function motionPermissionRequest(): Promise<PermissionState | "granted"> {
  const motion = window.DeviceMotionEvent as typeof DeviceMotionEvent & {
    requestPermission?: () => Promise<PermissionState>;
  };
  return motion.requestPermission ? motion.requestPermission() : Promise.resolve("granted");
}

export function ShakeToDictateProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledState] = useState(readInitial);
  const [status, setStatus] = useState<SetupStatus>(() => readInitial() ? "ready" : "idle");
  const [error, setError] = useState("");
  const reportSensorUnavailable = useCallback(() => {
    const message = "No motion data is available. Check browser permissions or use the microphone button.";
    setError(message);
    toast(message, { id: "shake-to-dictate-sensor" });
  }, []);

  const setEnabled = useCallback(async (next: boolean) => {
    setError("");
    if (!next) {
      savePreference(false);
      setEnabledState(false);
      setStatus("idle");
      return;
    }

    if (!window.isSecureContext || !("DeviceMotionEvent" in window) || !navigator.mediaDevices?.getUserMedia || !("AudioContext" in window)) {
      setStatus("unsupported");
      setError("Shake input needs a secure connection, motion sensors, and microphone support.");
      return;
    }

    setStatus("requesting");
    // Start all permission and audio-unlock calls inside the settings tap. Some
    // browsers require transient user activation for each of these APIs.
    let motion: Promise<PermissionState | "granted">;
    let microphone: Promise<MediaStream>;
    let audio: AudioContext;
    let audioReady: Promise<void>;
    try {
      motion = motionPermissionRequest();
      microphone = navigator.mediaDevices.getUserMedia({ audio: true });
      audio = getVoiceAudioContext();
      audioReady = audio.resume();
    } catch {
      retainVoiceAudioContext(false);
      setStatus("unsupported");
      setError("Motion or audio permissions could not be requested. Try again or use the microphone button.");
      return;
    }

    const [motionResult, microphoneResult, audioResult] = await Promise.allSettled([motion, microphone, audioReady]);
    if (microphoneResult.status === "fulfilled") microphoneResult.value.getTracks().forEach(track => track.stop());
    const deniedMotion = motionResult.status === "rejected" || motionResult.value !== "granted";
    const deniedMicrophone = microphoneResult.status === "rejected";
    if (deniedMotion || deniedMicrophone || audioResult.status === "rejected" || audio.state !== "running") {
      retainVoiceAudioContext(false);
      setEnabledState(false);
      savePreference(false);
      setStatus(deniedMotion || deniedMicrophone ? "denied" : "unsupported");
      setError(deniedMotion
        ? "Allow motion access in browser settings, then try again."
        : deniedMicrophone ? "Allow microphone access to start voice input by shaking."
          : "Audio input could not be prepared. Try again or use the microphone button.");
      return;
    }

    savePreference(true);
    retainVoiceAudioContext(true);
    setEnabledState(true);
    setStatus("ready");
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const unlock = () => {
      retainVoiceAudioContext(true);
      const context = getVoiceAudioContext();
      if (context.state !== "running") void context.resume().catch(() => {});
    };
    const close = (event: PageTransitionEvent) => { if (!event.persisted) closeVoiceAudioContext(); };
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
    window.addEventListener("pagehide", close);
    return () => {
      retainVoiceAudioContext(false);
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("pagehide", close);
    };
  }, [enabled]);

  return <Context.Provider value={{ enabled, status, error, reportSensorUnavailable, setEnabled }}>{children}</Context.Provider>;
}

export function useShakeToDictate() {
  const value = useContext(Context);
  if (!value) throw new Error("useShakeToDictate must be used within ShakeToDictateProvider");
  return value;
}
