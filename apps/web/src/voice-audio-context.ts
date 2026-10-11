let sharedContext: AudioContext | undefined;
let retainedForShake = false;
let activeVoiceInputs = 0;

/** Keep one unlocked context so motion events can start the existing voice pipeline. */
export function getVoiceAudioContext(): AudioContext {
  if (!sharedContext || sharedContext.state === "closed") sharedContext = new AudioContext();
  return sharedContext;
}

export function closeVoiceAudioContext() {
  const context = sharedContext;
  sharedContext = undefined;
  retainedForShake = false;
  if (context && context.state !== "closed") void context.close().catch(() => {});
}

export function retainVoiceAudioContext(retain: boolean) {
  retainedForShake = retain;
  if (!retain && activeVoiceInputs === 0) closeVoiceAudioContext();
}

export function beginVoiceAudioUse() {
  activeVoiceInputs++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeVoiceInputs = Math.max(0, activeVoiceInputs - 1);
    if (!retainedForShake && activeVoiceInputs === 0) closeVoiceAudioContext();
  };
}
