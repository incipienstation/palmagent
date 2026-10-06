import { SettingsStore } from "./adapters/outbound/settings-store.js";
import { SpaceSettingsService } from "./application/use-cases/space-settings.js";

export function createSpaceSettings(dataDir: string, fallbackRoots: string[] = []) {
  const store = new SettingsStore(dataDir, fallbackRoots);
  return Object.assign(new SpaceSettingsService(store, store), { path: store.path, dataDir });
}
