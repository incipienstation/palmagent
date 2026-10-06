import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { AuthenticationSchema, RegistrationSchema, RegisterOptionsSchema } from "@palmagent/shared/requests";
import type { AuthCredentials, IssuedToken } from "../../domain/session.js";
const CHALLENGE_COOKIE_NAME = "wa_chal";
import { ApplicationError } from "../../../../kernel/errors.js";
import { jsonBody } from "../../../../platform/http/input.js";
import type { HttpDependencies } from "./http-dependencies.js";

export function authCredentials(c: Context, cookieName: string): AuthCredentials {
  return { sessionToken: getCookie(c, cookieName), challengeId: getCookie(c, CHALLENGE_COOKIE_NAME) };
}
function applyToken(c: Context, name: string, token: IssuedToken) {
  setCookie(c, name, token.value, { path: "/", httpOnly: true, secure: true, sameSite: "Lax", maxAge: token.maxAge });
}
export function authRoutes({ auth, config }: Pick<HttpDependencies, "auth" | "config">) {
  const app = new Hono();
  const credentials = (c: Context) => authCredentials(c, config.cookieName);
  return app
    .get("/me", (c) => c.json(auth.status(credentials(c)), 200))
    .post("/login/options", async (c) => {
      const result = await auth.beginAuthentication();
      applyToken(c, CHALLENGE_COOKIE_NAME, result.challenge);
      return c.json(result.options, 200);
    })
    .post("/login/verify", jsonBody(AuthenticationSchema), async (c) => {
      const result = await auth.finishAuthentication(credentials(c), c.req.valid("json"));
      applyToken(c, config.cookieName, result.session);
      applyToken(c, CHALLENGE_COOKIE_NAME, { value: "", maxAge: 0 });
      return c.json({ ok: true }, 200);
    })
    .post("/register/options", jsonBody(RegisterOptionsSchema), async (c) => {
      const input = c.req.valid("json");
      const result = await auth.beginRegistration(credentials(c), input.token || undefined);
      applyToken(c, CHALLENGE_COOKIE_NAME, result.challenge);
      return c.json(result.options, 200);
    })
    .post("/register/verify", jsonBody(RegistrationSchema), async (c) => {
      const input = c.req.valid("json");
      const result = await auth.finishRegistration(credentials(c), input.response, input.label || undefined);
      applyToken(c, config.cookieName, result.session);
      applyToken(c, CHALLENGE_COOKIE_NAME, { value: "", maxAge: 0 });
      return c.json({ ok: true }, 201);
    })
    .post("/logout", (c) => {
      auth.logout(credentials(c));
      applyToken(c, config.cookieName, { value: "", maxAge: 0 });
      return c.json({ ok: true }, 200);
    })
    .post("/enroll-token", (c) => {
      if (auth.enabled && !auth.verifySession(credentials(c).sessionToken)) throw new ApplicationError("unauthorized", "unauthorized");
      return c.json(auth.mintEnrollToken(), 201);
    });
}
