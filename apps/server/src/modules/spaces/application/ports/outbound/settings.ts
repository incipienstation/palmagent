export interface SavedSpaceSettings { schemaVersion: 1; repoRoots?: string[]; [key: string]: unknown }
export interface SpaceSettingsStorage {
  readSaved(): SavedSpaceSettings;
  defaults(): string[];
  write(saved: SavedSpaceSettings): void;
  lock(): () => void;
}
export interface SpaceSearchPaths {
  normalize(path: string): string;
  assertReadable(path: string): void;
}
