// Compile-time Hono RPC checks. The browser API type is inferred from the server's
// chained routes; keeping this outside *.test.ts avoids loading it at runtime.
import { hc } from "hono/client";
import type { AppType } from "../src/http-api.js";

async function clientTypeChecks(client: ReturnType<typeof hc<AppType>>) {
  const response = await client.api.tasks.$get({ query: {} });
  if (response.ok) {
    (await response.json()).tasks;
  } else {
    const error = await response.json();
    const message: string = error.error;
    const code: string | undefined = error.code;
    // @ts-expect-error Failed responses must not masquerade as task lists.
    error.tasks;
  }
  const compatibility = await client.api.compatibility.$get();
  if (compatibility.ok) (await compatibility.json()).agents;
  // @ts-expect-error Missing task id must fail at the client call site.
  client.api.tasks[":id"].$get({ param: {} });
  // @ts-expect-error The schema requires a string title.
  client.api.tasks[":id"].$patch({ param: { id: "fixture" }, json: { title: 12 } });
  const latestHistory = await client.api.tasks[":id"].history.$get({ param: { id: "fixture" }, query: {} });
  if (latestHistory.ok) (await latestHistory.json()).cursor;
  // @ts-expect-error A history cursor, when supplied, travels as query text.
  client.api.tasks[":id"].history.$get({ param: { id: "fixture" }, query: { before: 12 } });
  // @ts-expect-error Image reads require an explicit local path.
  client.api.tasks[":id"].image.$get({ param: { id: "fixture" }, query: {} });
  // @ts-expect-error Unknown routes must not silently become fetch URLs.
  client.api.tasks[":id"].rename.$post({ param: { id: "fixture" } });
}
