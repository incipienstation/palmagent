import { SAVE_KEY, LEGACY_SAVE_KEY, type RunStorage } from "./scrap-survivor/api";

/** Browser persistence belongs to the host; the game receives only this small storage contract. */
let unsaved: string | undefined;
export const survivorStorage: RunStorage = {
  load: () => unsaved ?? localStorage.getItem(SAVE_KEY) ?? localStorage.getItem(LEGACY_SAVE_KEY),
  save: value => {
    // Keep this tab's run available when a closed sheet unmounts during a storage failure.
    unsaved = value;
    localStorage.setItem(SAVE_KEY, value);
    unsaved = undefined;
  },
};
