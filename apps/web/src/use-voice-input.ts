import { useLayoutEffect, useRef, useState } from "react";
import type { SkillContext } from "@palmagent/shared";
import { VoiceInput, type VoiceState } from "./voice-input";

export function useVoiceInput(context: SkillContext | undefined, scope: string, disabled: boolean,
  insert: (text: string) => void, canInsert: () => boolean) {
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState("");
  const session = useRef<VoiceInput | undefined>(undefined);
  const callbacks = useRef({ insert, canInsert }); callbacks.current = { insert, canInsert };
  const key = JSON.stringify(context);
  useLayoutEffect(() => {
    setError("");
    const leave = () => session.current?.cancel();
    const hide = () => { if (document.hidden) leave(); };
    window.addEventListener("pagehide", leave); document.addEventListener("visibilitychange", hide);
    return () => { leave(); window.removeEventListener("pagehide", leave); document.removeEventListener("visibilitychange", hide); };
  }, [key, scope, disabled]);
  return { state, error, active: state !== "idle", toggle: () => {
    if (state !== "idle") { session.current?.stop(); return; }
    if (!context || disabled) return;
    setError("");
    const voice = new VoiceInput(context, text => callbacks.current.insert(text), setState, setError, () => callbacks.current.canInsert());
    session.current = voice; void voice.start();
  } };
}
