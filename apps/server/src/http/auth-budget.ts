import type { MiddlewareHandler } from "hono";

/** Process-wide backstop for public authentication work. Per-client limits belong
 * at the ingress, which knows the peer; forwarded headers are not trusted here. */
export function authBudget(now: () => number = () => performance.now()): MiddlewareHandler {
  const burst = 40;
  let tokens = burst;
  let last = now();
  return async (c, next) => {
    if (c.req.method === "POST" && c.req.path.startsWith("/api/auth/")) {
      const time = now();
      tokens = Math.min(burst, tokens + Math.max(0, time - last) * 20 / 1000);
      last = time;
      if (tokens < 1) {
        c.header("Retry-After", "1");
        return c.json({ error: "too many authentication requests" }, 429);
      }
      tokens--;
    }
    await next();
  };
}
