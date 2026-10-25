import { parseArgs } from "node:util";

/** Keep the existing bare connection JSON contract; diagnosis is an additive subcommand. */
export async function connectionCommand(args: string[], environment: {
  connection(dataDir?: string): unknown;
  diagnose(dataDir?: string): Promise<unknown>;
}) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: palmagent connection [--data-dir <path>]\n       palmagent connection diagnose [--data-dir <path>]\n\nPrint the connection contract, or check public HTTPS, authentication and SSE from this host.\nDiagnosis creates a short-lived session and removes it on completion; it does not prove off-host reachability.");
    return;
  }
  const diagnostic = args[0] === "diagnose";
  const { values } = parseArgs({ args: diagnostic ? args.slice(1) : args, strict: true, allowPositionals: false,
    options: { "data-dir": { type: "string" } } });
  console.log(JSON.stringify(diagnostic ? await environment.diagnose(values["data-dir"]) : environment.connection(values["data-dir"])));
}
