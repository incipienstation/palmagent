import { createServer, request } from "node:http";

// Fixture ingress only: preserve the production owner's authentication checks.
// No browser bundle, WebSocket/SSE recovery, TLS, or production routing claim.
export function proxyServer(target, view = false) {
  return createServer((req, res) => {
    if (view && !req.url.startsWith("/api/")) {
      res.end("Synthetic view");
      return;
    }
    const upstream = request({ hostname: "localhost", port: target(req.url),
      method: req.method, path: req.url, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(503, { "content-type": "application/json" });
      res.end('{"error":"fixture upstream unavailable"}');
    });
    req.on("aborted", () => upstream.destroy());
    req.pipe(upstream);
  });
}

export async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "localhost", resolve);
  });
  return server.address().port;
}

if (process.send) {
  const port = await listen(proxyServer(() => Number(process.argv[2]), true));
  process.send({ port });
}
