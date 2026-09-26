import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { AuthenticationSchema, RegistrationSchema, RegisterOptionsSchema } from "@palmagent/shared/requests";
import { CHALLENGE_COOKIE_NAME, type AuthCookie, type AuthCredentials } from "../../auth.js";
import { ApplicationError } from "../../errors.js";
import { jsonBody } from "../input.js";
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
  return app
    .get("/me", (c) => c.json(auth.status(credentials(c)), 200))
    .post("/login/options", async (c) => {
      const result = await auth.beginAuthentication();
      applyCookies(c, result.setCookie);
      return c.json(result.options, 200);
    })
    .post("/login/verify", jsonBody(AuthenticationSchema), async (c) => {
      const result = await auth.finishAuthentication(credentials(c), c.req.valid("json"));
      applyCookies(c, ...result.setCookies);
      return c.json({ ok: true }, 200);
    })
    .post("/register/options", jsonBody(RegisterOptionsSchema), async (c) => {
      const input = c.req.valid("json");
      const result = await auth.beginRegistration(credentials(c), input.token || undefined);
      applyCookies(c, result.setCookie);
      return c.json(result.options, 200);
    })
    .post("/register/verify", jsonBody(RegistrationSchema), async (c) => {
      const input = c.req.valid("json");
      const result = await auth.finishRegistration(credentials(c), input.response, input.label || undefined);
      applyCookies(c, ...result.setCookies);
      return c.json({ ok: true }, 201);
    })
    .post("/logout", (c) => {
      applyCookies(c, auth.logout(credentials(c)));
      return c.json({ ok: true }, 200);
    })
    .post("/enroll-token", (c) => {
      if (auth.enabled && !auth.verifySession(credentials(c).sessionToken)) throw new ApplicationError("unauthorized", "unauthorized");
      return c.json(auth.mintEnrollToken(), 201);
    });
}
