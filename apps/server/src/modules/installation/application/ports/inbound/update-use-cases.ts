import type { UpdateAction, UpdateSettingsChange, UpdateSettingsState } from "@palmagent/shared/updates";

/** Operations accepted by the installation module. */
export interface UpdateUseCases {
  status(): Promise<UpdateSettingsState>;
  change(change: UpdateSettingsChange): Promise<UpdateSettingsState>;
  action(action: UpdateAction): Promise<UpdateSettingsState>;
  resume(): Promise<UpdateSettingsState>;
}
