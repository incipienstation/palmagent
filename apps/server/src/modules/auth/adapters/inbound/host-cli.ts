import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { HostLogin } from "../../application/ports/inbound/host-login.js";

const help = `palmagent auth <operation> [--data-dir <path>]
  status               Show methods, callback URL, and pending verified account
  github-prepare       --client-id <id> --secret-file <path>   Create a private setup link
  github-confirm       --owner-id <numeric-id>                 Activate the verified account
  remove-github        Unlink GitHub and end GitHub sessions
  remove-passkeys      Remove registered passkeys and end passkey sessions
  logout-all           End all sessions and pending sign-ins`;

type Open = (dataDir: string | undefined, run: (host: HostLogin, origin: string) => void) => void;
export function authCommand(args: string[], open: Open) {
  const [operation, ...rest] = args;
  if (!operation || args.includes("--help") || args.includes("-h")) { console.log(help); return; }
  const { values } = parseArgs({ args: rest, allowPositionals: false, strict: true, options: {
    "data-dir": { type: "string" },
    ...(operation === "github-prepare" ? { "client-id": { type: "string" as const }, "secret-file": { type: "string" as const } } : {}),
    ...(operation === "github-confirm" ? { "owner-id": { type: "string" as const } } : {}),
  } });
  open(values["data-dir"], (host, origin) => {
    switch (operation) {
      case "status":
        console.log(JSON.stringify({ ...host.status(), callbackUrl: origin + "/api/auth/github/callback" }));
        return;
      case "github-prepare": {
        const clientId = values["client-id"], path = values["secret-file"];
        if (typeof clientId !== "string" || typeof path !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(clientId)) throw new Error(help);
        const secret = readFileSync(path, "utf8").trim();
        if (!/^[!-~]{1,512}$/.test(secret)) throw new Error("Invalid GitHub client secret file.");
        const { bindingKey, expiresAt } = host.prepare({ clientId, clientSecret: secret });
        console.log(JSON.stringify({ setupUrl: origin + "/#/github-setup/" + bindingKey, expiresAt }));
        return;
      }
      case "github-confirm": {
        const id = values["owner-id"];
        if (typeof id !== "string" || !/^[1-9][0-9]*$/.test(id)) throw new Error(help);
        host.confirm(id);
        break;
      }
      case "remove-github": host.remove("github"); break;
      case "remove-passkeys": host.remove("passkey"); break;
      case "logout-all": host.revokeSessions(); break;
      default: throw new Error(help);
    }
    console.log(JSON.stringify(host.status()));
  });
}
