import type { InstallationFeedback } from "../../application/ports/outbound/installation.js";
import { confirm, log } from "./sh.js";
import { printChecks } from "./checks.js";

export const installationFeedback: InstallationFeedback = {
  ...log, confirm,
  checks: (title, checks) => { printChecks(title, checks); },
  plan: plan => { console.log(JSON.stringify(plan)); },
};
