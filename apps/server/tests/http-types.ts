// Compile-time contract tests: server route inference must match the shared RPC
// contract. Keeping this outside *.test.ts avoids loading browser types at runtime.
import type { ExtractSchema } from "hono/types";
import { hc } from "hono/client";
import type { Api, ApiSchema } from "@palmagent/shared/http";
import type { createApp } from "../src/http/app.js";

type Actual = ExtractSchema<ReturnType<typeof createApp>>;
type Assert<T extends true> = T;
type ContractPathsExist = Assert<keyof ApiSchema extends keyof Actual ? true : false>;
type ServerMatchesContract = Assert<Actual extends ApiSchema ? true : false>;
type ClientMatchesServer = Assert<ApiSchema extends Pick<Actual, keyof ApiSchema> ? true : false>;

// Health/build discovery and the long-lived stream are transport endpoints;
// every other endpoint must remain represented in the browser contract.
type AllRestPathsCovered = Assert<Exclude<keyof Actual, "/api/health" | "/api/compatibility" | "/api/stream"> extends keyof ApiSchema ? true : false>;

function clientTypeChecks(client: ReturnType<typeof hc<Api>>) {
  // @ts-expect-error Missing task id must fail at the client call site.
  client.api.tasks[":id"].$get({ param: {} });
  // @ts-expect-error The schema requires a string title.
  client.api.tasks[":id"].$patch({ param: { id: "fixture" }, json: { title: 12 } });
  // @ts-expect-error A history cursor is required and travels as query text.
  client.api.tasks[":id"].history.$get({ param: { id: "fixture" }, query: {} });
  // @ts-expect-error Unknown routes must not silently become fetch URLs.
  client.api.tasks[":id"].rename.$post({ param: { id: "fixture" } });
}
