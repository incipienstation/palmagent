import type { InstallationUseCases } from "../ports/inbound/installation-use-cases.js";
import type { InstallationDependencies } from "../ports/outbound/installation.js";
import { createInstallationLifecycle } from "./installation-lifecycle.js";
import { createInstallationUpdate } from "./installation-update.js";

export function createInstallationService(dependencies: InstallationDependencies): InstallationUseCases {
  const lifecycle = createInstallationLifecycle(dependencies);
  return { install: lifecycle.install, setup: lifecycle.setup, uninstall: lifecycle.uninstall,
    prepareRuntime: lifecycle.prepareRuntime, provisionRuntime: lifecycle.provisionRuntime,
    passkey: lifecycle.passkey, doctor: lifecycle.doctor,
    update: createInstallationUpdate(dependencies, lifecycle) };
}
