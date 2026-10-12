import assert from "node:assert/strict";
import http from "node:http";
import { createShareGateway } from "../scripts/share-gateway.mjs";

const publicOrigin = "https://recruiter-test.ngrok-free.app";
const password = "fixture-password-not-for-real-use";
const auth = "Basic " + Buffer.from(`recruiter:${password}`).toString("base64");
let forwarded = 0;
const upstream = http.createServer((request, response) => {
  forwarded++;
  if (request.url === "/events") { response.writeHead(200, { "content-type": "text/event-stream" }); response.write('data: {"message":"Live fixture event"}\n\n'); return; }
  response.end(JSON.stringify({ host: request.headers.host, origin: request.headers.origin || null, authorization: request.headers.authorization || null, path: request.url }));
});
await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
const config = { upstream: upstreamUrl, publicOrigin, username: "recruiter", password };
for (const invalid of [{ upstream: "http://example.com" }, { publicOrigin: "http://example.com" }, { publicOrigin: "https://user:secret@example.com" }, { password: "short" }]) assert.throws(() => createShareGateway({ ...config, ...invalid }));
const gateway = createShareGateway(config);
await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
const send = (headers = {}, path = "/api/health", method = "GET", firstChunk = false) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: "127.0.0.1", port: gateway.address().port, path, method, headers: { host: new URL(publicOrigin).host, "x-forwarded-proto": "https", ...headers } }, response => {
    let body = "";
    response.on("data", chunk => { body += chunk; if (firstChunk) { resolve({ status: response.statusCode, body }); req.destroy(); } });
    response.on("end", () => resolve({ status: response.statusCode, body, headers: response.headers }));
    response.on("error", reject);
  });
  req.on("error", reject);
  req.end();
});
try {
  assert.equal((await send()).status, 401);
  assert.equal((await send({ authorization: "Basic wrong" })).status, 401);
  assert.equal((await send({ authorization: auth, origin: "https://untrusted.example" }, "/api/runs", "POST")).status, 403);
  assert.equal((await send({ authorization: auth, host: "evil.example" })).status, 403);
  assert.equal((await send({ authorization: auth, "x-forwarded-proto": "http" })).status, 400);
  assert.equal(forwarded, 0, "Unauthenticated or foreign-origin requests must never reach browser tools");
  const valid = await send({ authorization: auth, origin: publicOrigin });
  assert.equal(valid.status, 200);
  assert.equal(valid.headers["x-frame-options"], "DENY");
  assert.deepEqual(JSON.parse(valid.body), { host: new URL(upstreamUrl).host, origin: null, authorization: null, path: "/api/health" });
  assert.equal((await send({ authorization: auth }, "//evil.example/")).status, 400);
  const event = await send({ authorization: auth }, "/events", "GET", true);
  assert.equal(event.status, 200);
  assert.match(event.body, /Live fixture event/);
  console.log("Recruiter gateway checks passed: password, exact Host/Origin, HTTPS, credential stripping, loopback-only upstream and unbuffered events.");
} finally {
  gateway.closeAllConnections(); upstream.closeAllConnections();
  await Promise.all([new Promise(resolve => gateway.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
}
