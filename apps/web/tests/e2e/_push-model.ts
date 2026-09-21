import { buildSync } from "esbuild";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";

// Execute both production modules in a fresh realm for each case. Only platform
// and UI boundaries are replaced; subscription cleanup and preference ordering
// remain real. These tests use no page, browser context, or fixture server.
const source = buildSync({
  entryPoints: [fileURLToPath(new URL("../../src/push-preference.ts", import.meta.url))],
  bundle: true, platform: "node", format: "cjs", write: false,
  external: ["./api", "./components/ui/toaster", "./update-state"],
}).outputFiles[0].text;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function pushModel(permission: NotificationPermission = "granted", subscribed = false) {
  let now = 0, timerId = 0, work = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let permissionResult = deferred<NotificationPermission>();
  const probe = {
    permission, subscribed, permissionRequests: 0, subscriptions: 0, failUnsubscribe: false,
    calls: [] as string[], toasts: [] as Array<{ title: string }>,
    request: async (_operation: string) => {},
  };
  const subscription = {
    endpoint: "https://push.example.test/subscription",
    toJSON: () => ({ keys: { p256dh: "test", auth: "test" } }),
    unsubscribe: async () => {
      if (probe.failUnsubscribe) return false;
      probe.subscribed = false;
      return true;
    },
  };
  const request = async (operation: string) => {
    probe.calls.push(operation);
    await probe.request(operation);
  };
  const dependencies: Record<string, unknown> = {
    "./api": { api: { push: {
      key: async () => { await request("key"); return { publicKey: "AQID" }; },
      subscribe: async () => { await request("subscribe"); },
      unsubscribe: async () => { await request("unsubscribe"); },
    } } },
    "./components/ui/toaster": { toast: (value: { title: string }) => probe.toasts.push(value) },
    "./update-state": { beginBrowserWork: () => { work++; return () => { work--; }; } },
  };
  const notification = {
    get permission() { return probe.permission; },
    requestPermission: () => {
      probe.permissionRequests++;
      permissionResult = deferred<NotificationPermission>();
      return permissionResult.promise.then(result => { probe.permission = result; return result; });
    },
  };
  const module = { exports: {} };
  runInNewContext(source, {
    module, exports: module.exports,
    require: (name: string) => {
      if (!(name in dependencies)) throw new Error(`Unexpected push model dependency: ${name}`);
      return dependencies[name];
    },
    Notification: notification,
    window: { Notification: notification, PushManager: class {} },
    navigator: { serviceWorker: { ready: Promise.resolve({ pushManager: {
      getSubscription: async () => probe.subscribed ? subscription : null,
      subscribe: async () => { probe.subscriptions++; probe.subscribed = true; return subscription; },
    } }) } },
    Uint8Array, ArrayBuffer, atob,
    setTimeout: (run: () => void, delay: number) => {
      const id = ++timerId; timers.set(id, { at: now + delay, run }); return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const preference = module.exports as typeof import("../../src/push-preference");
  return {
    ...preference, probe, work: () => work, turn,
    resolvePermission: async (value: NotificationPermission) => { permissionResult.resolve(value); await turn(); },
    advance: async (milliseconds: number) => {
      const end = now + milliseconds;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= end);
        if (!next) break;
        const [id, timer] = next; now = timer.at; timers.delete(id); timer.run(); await turn();
      }
      now = end; await turn();
    },
  };
}
