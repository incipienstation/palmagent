import { createHostReadiness } from "../platform/process/host-readiness.js";
import { runRoutineHost } from "../composition/routine-host.js";

const [directory, id] = process.argv.slice(2);
if (!directory || !id) throw new Error("Routine state directory and run identity are required");
await runRoutineHost(directory, id, createHostReadiness());
