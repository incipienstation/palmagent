import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { AuthenticationSchema, RegistrationSchema, RegisterOptionsSchema } from "@palmagent/shared/requests";
import { CHALLENGE_COOKIE_NAME, type AuthCookie, type AuthCredentials } from "../../auth.js";
import { body } from "../input.js";
import type { HttpDependencies } from "../types.js";

export function authCredentials(c: Context, cookieName: string): AuthCredentials {
  return { sessionToken: getCookie(c, cookieName), challengeId: getCookie(c, CHALLENGE_COOKIE_NAME) };
}
function applyCookies(c: Context, ...cookies: AuthCookie[]) {
  for (const cookie of cookies) setCookie(c, cookie.name, cookie.value, {
    path: "/", httpOnly: true, secure: true, sameSite: "Lax", maxAge: cookie.maxAge,
  });
}
export function authRoutes({ auth, config }: HttpDependencies) {
  const app = new Hono();
  const credentials = (c: Context) => authCredentials(c, config.cookieName);
  app.get("/me", (c) => c.json(auth.status(credentials(c))));
  app.post("/login/options", async (c) => {
    const result = await auth.beginAuthentication();
    applyCookies(c, result.setCookie);
    return c.json(result.options);
  });
  app.post("/login/verify", async (c) => {
    const result = await auth.finishAuthentication(credentials(c), await body(c, AuthenticationSchema));
    applyCookies(c, ...result.setCookies);
    return c.json({ ok: true });
  });
  app.post("/register/options", async (c) => {
    const input = await body(c, RegisterOptionsSchema);
    const result = await auth.beginRegistration(credentials(c), input.token || undefined);
    applyCookies(c, result.setCookie);
    return c.json(result.options);
  });
  app.post("/register/verify", async (c) => {
    const input = await body(c, RegistrationSchema);
    const result = await auth.finishRegistration(credentials(c), input.response, input.label || undefined);
    applyCookies(c, ...result.setCookies);
    return c.json({ ok: true }, 201);
  });
  app.post("/logout", (c) => {
    applyCookies(c, auth.logout(credentials(c)));
    return c.json({ ok: true });
  });
  app.post("/enroll-token", (c) => {
    if (auth.enabled && !auth.verifySession(credentials(c).sessionToken)) return c.json({ error: "unauthorized" }, 401);
    return c.json(auth.mintEnrollToken(), 201);
  });
  return app;
}
