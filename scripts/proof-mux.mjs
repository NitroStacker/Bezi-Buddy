import http from "node:http";
import net from "node:net";

const options = parseArguments(process.argv.slice(2));
const host = "127.0.0.1";

function targetPort(pathname) {
  return pathname === "/health" || pathname.startsWith("/v1/")
    ? options.relay
    : options.metro;
}

const server = http.createServer((request, response) => {
  const port = targetPort(request.url ?? "/");
  const upstream = http.request(
    {
      host,
      port,
      method: request.method,
      path: request.url,
      headers: request.headers,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", (error) => {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "application/json" });
    }
    response.end(JSON.stringify({ error: "proof_upstream_unavailable", message: error.message }));
  });
  request.pipe(upstream);
});

server.on("upgrade", (request, socket, head) => {
  const port = targetPort(request.url ?? "/");
  const upstream = net.connect(port, host, () => {
    upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`);
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      upstream.write(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}\r\n`);
    }
    upstream.write("\r\n");
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(options.listen, host, () => {
  process.stdout.write(
    `Bezi Remote proof mux listening on http://${host}:${options.listen} ` +
      `(Metro ${options.metro}, relay ${options.relay})\n`,
  );
});

function parseArguments(values) {
  const parsed = { listen: 8090, metro: 8081, relay: 8787 };
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index]?.replace(/^--/, "");
    const value = Number(values[index + 1]);
    if (!(name in parsed) || !Number.isInteger(value) || value < 1 || value > 65_535) {
      throw new Error(`Invalid proof mux argument: ${values[index]} ${values[index + 1]}`);
    }
    parsed[name] = value;
  }
  return parsed;
}
