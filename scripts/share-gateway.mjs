import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

export function createShareGateway({ upstream, publicOrigin, username, password }) {
  const target = new URL(upstream);
  const origin = new URL(publicOrigin);
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(target.hostname)
    || target.username || target.password || target.pathname !== "/" || target.search || target.hash) throw new Error("Sharing upstream must be a loopback HTTP service.");
  if (origin.protocol !== "https:" || origin.username || origin.password || publicOrigin !== origin.origin) throw new Error("Sharing requires one exact HTTPS origin.");
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(username || "") || typeof password !== "string" || password.length < 16 || password.length > 128) throw new Error("Sharing requires a username and a strong password.");
  const digest = value => createHash("sha256").update(value).digest();
  const expected = digest("Basic " + Buffer.from(`${username}:${password}`).toString("base64"));
  const deny = (response, status, message, extra = {}) => {
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", ...extra });
    response.end(message);
  };
  return http.createServer((request, response) => {
    const loopbackHost = `127.0.0.1:${request.socket.localPort}`;
    if (![origin.host, loopbackHost, `localhost:${request.socket.localPort}`].includes(request.headers.host)
      || (request.headers.origin && request.headers.origin !== origin.origin)) return deny(response, 403, "Untrusted sharing origin.");
    if (request.headers["x-forwarded-proto"] !== "https") return deny(response, 400, "Use the HTTPS sharing link.");
    if (!timingSafeEqual(digest(request.headers.authorization || ""), expected)) return deny(response, 401, "Recruiter login required.", { "www-authenticate": 'Basic realm="StayPilot recruiter test", charset="UTF-8"' });
    if (!request.url.startsWith("/") || request.url.startsWith("//")) return deny(response, 400, "Invalid request path.");
    const headers = { ...request.headers, host: target.host };
    // Forward only after authenticating and checking the original public Origin.
    for (const name of ["authorization", "origin", "forwarded", "x-forwarded-host", "x-forwarded-proto"]) delete headers[name];
    const proxy = http.request({ hostname: target.hostname, port: target.port || 80, path: request.url, method: request.method, headers }, upstreamResponse => {
      proxy.setTimeout(0);
      response.writeHead(upstreamResponse.statusCode, { ...upstreamResponse.headers, "x-frame-options": "DENY" });
      upstreamResponse.on("error", () => response.destroy());
      upstreamResponse.pipe(response);
    });
    const isIntake = request.method === "POST" && request.url.split("?", 1)[0] === "/api/intake";
    // Intake includes free-plan pacing inside a 90s model deadline; other requests should fail quickly.
    proxy.setTimeout(isIntake ? 100_000 : 20_000, () => proxy.destroy(new Error("Upstream timeout")));
    proxy.on("error", () => { if (!response.headersSent) deny(response, 502, "The agent service is unavailable."); else response.destroy(); });
    request.on("aborted", () => proxy.destroy());
    response.on("close", () => proxy.destroy());
    request.pipe(proxy);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.loadEnvFile(".env.share");
  const server = createShareGateway({ upstream: process.env.SHARE_UPSTREAM, publicOrigin: process.env.SHARE_PUBLIC_ORIGIN, username: process.env.SHARE_USERNAME, password: process.env.SHARE_PASSWORD });
  const port = Number(process.env.SHARE_PORT || 4185);
  server.listen(port, "127.0.0.1", () => console.log(`Protected recruiter gateway ready on loopback port ${port}`));
  const shutdown = () => { server.closeAllConnections(); server.close(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
