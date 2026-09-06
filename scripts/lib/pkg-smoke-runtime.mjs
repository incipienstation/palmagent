import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { delimiter, dirname, join } from "node:path";

// Unknown host variables are excluded by default. In particular, never inherit
// application paths, runner sockets, provider credentials, or Node preload hooks.
export function smokeEnv(parent, scratch, port) {
  const env = {};
  for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (parent[name]) env[name] = parent[name];
  }
  return {
    ...env,
    PATH: dirname(process.execPath) + delimiter + (parent.PATH || ""),
    HOME: join(scratch, "home"),
    USERPROFILE: join(scratch, "home"),
    XDG_CONFIG_HOME: join(scratch, "home/config"),
    XDG_CACHE_HOME: join(scratch, "cache"),
    TMPDIR: join(scratch, "tmp"),
    TMP: join(scratch, "tmp"),
    TEMP: join(scratch, "tmp"),
    npm_config_cache: join(scratch, "cache/npm"),
    npm_config_userconfig: join(scratch, "home/npmrc"),
    NODE_ENV: "test",
    AUTH_DISABLED: "1",
    HOST: "localhost",
    PORT: String(port),
    DISPATCHER_DATA_DIR: join(scratch, "data"),
    DISPATCHER_DB: join(scratch, "data/palmagent.db"),
    VAPID_KEY_PATH: join(scratch, "data/vapid.json"),
    CLAUDE_CONFIG_DIR: join(scratch, "home/claude"),
    CODEX_HOME: join(scratch, "home/codex"),
  };
}

export async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "localhost", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

export function startSmokeServer(bin, scratch, env) {
  const child = spawn(bin, ["start"], {
    cwd: scratch, env, detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let spawnError;
  child.stdout.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
  child.stderr.on("data", (chunk) => { output += chunk; process.stderr.write(chunk); });
  child.on("error", (error) => { spawnError = error; });
  return {
    child,
    assertRunning() {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error("smoke server exited before validation completed");
      }
    },
    listening() {
      return output.includes(`internal listener on localhost:${env.PORT} `);
    },
    async stop() {
      if (child.pid) {
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      if (child.exitCode === null && child.signalCode === null && !spawnError) {
        await new Promise((resolve) => child.once("close", resolve));
      }
    },
  };
}
