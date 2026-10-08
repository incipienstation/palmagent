/** A local send intent, emitted only after the existing submission guard accepts it. */
export type GameDelivery = { id: string; taskId?: string; state: "sending" | "sent" | "failed" };
const listeners = new Set<(event: GameDelivery) => void>();
export function gameDelivery(event: GameDelivery) { listeners.forEach(listener => listener(event)); }
export function onGameDelivery(listener: (event: GameDelivery) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
let warming: Promise<unknown> | undefined;
export function warmSurvivor() {
  return warming ??= import("./scrap-survivor/scene").then(m => m.preloadSprites()).catch(() => { warming = undefined; });
}
