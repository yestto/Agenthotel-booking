import http from "node:http";

const worker = (await import(new URL("../dist/server/index.js", import.meta.url))).default;
const port = Number(process.env.PORT || 4173);

const server = http.createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
    const request = new Request(`http://${incoming.headers.host || `127.0.0.1:${port}`}${incoming.url}`, {
      method: incoming.method,
      headers: incoming.headers,
      body: hasBody ? Buffer.concat(chunks) : undefined,
      duplex: hasBody ? "half" : undefined,
    });
    const response = await worker.fetch(request, process.env, {});
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    outgoing.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    outgoing.end("Local server error");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`StayPilot running at http://127.0.0.1:${port}`);
});
