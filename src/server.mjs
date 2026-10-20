import http from "node:http";
import { pathToFileURL } from "node:url";
import { InputError } from "./evaluation.mjs";
import { runEvaluation } from "./coach.mjs";

const MAX_BODY_BYTES = 16_384;

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let chunks = [];
    let finished = false;
    const fail = error => { if (!finished) { finished = true; chunks = []; reject(error); } };
    request.on("data", chunk => {
      if (finished) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) fail(new HttpError(413, "body_too_large", "JSON body must be at most 16 KiB."));
      else chunks.push(chunk);
    });
    request.on("end", () => {
      if (finished) return;
      finished = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new HttpError(400, "invalid_json", "Body must contain valid JSON.")); }
    });
    request.on("aborted", () => fail(new HttpError(400, "request_aborted", "Request ended before the body arrived.")));
    request.on("error", fail);
  });
}

function send(response, status, body, headers = {}) {
  if (response.destroyed) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  response.end(JSON.stringify(body));
}

/** Local reference endpoint. No authentication or remote network exposure. */
export function createServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const port = request.socket.localPort;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(request.headers.host)) throw new HttpError(403, "invalid_host", "Only the local server hostname is accepted.");
      const origin = request.headers.origin;
      if (origin && !hosts.some(host => origin === `http://${host}`)) throw new HttpError(403, "invalid_origin", "Cross-origin browser requests are not accepted.");
      if (request.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "invalid_origin", "Cross-site browser requests are not accepted.");

      if (request.url === "/health") {
        if (request.method !== "GET") return send(response, 405, { error: { code: "method_not_allowed", message: "Use GET." } }, { Allow: "GET" });
        return send(response, 200, { status: "ok", mode: "local-reference", adapter: "local-template-v1" });
      }
      if (request.url !== "/v1/evaluations") throw new HttpError(404, "not_found", "Endpoint not found.");
      if (request.method !== "POST") return send(response, 405, { error: { code: "method_not_allowed", message: "Use POST." } }, { Allow: "POST" });
      if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers["content-type"] ?? "")) throw new HttpError(415, "unsupported_media_type", "Use Content-Type: application/json.");
      if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") throw new HttpError(415, "unsupported_encoding", "Compressed request bodies are not accepted.");
      if (Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES) throw new HttpError(413, "body_too_large", "JSON body must be at most 16 KiB.");
      return send(response, 200, await runEvaluation(await readJson(request)));
    } catch (error) {
      request.resume();
      if (error instanceof InputError) send(response, 422, { error: { code: "invalid_input", message: error.message, field: error.field } });
      else if (error instanceof HttpError) send(response, error.status, { error: { code: error.code, message: error.message } });
      else send(response, 500, { error: { code: "internal_error", message: "Evaluation could not be completed." } });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.setTimeout(15_000, socket => socket.destroy());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = process.env.PORT === undefined ? 8787 : Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("PORT must be an integer from 1024 to 65535.");
  const server = createServer();
  server.on("error", error => { console.error(`Cannot start local server: ${error.code ?? "unknown error"}`); process.exitCode = 1; });
  server.listen(port, "127.0.0.1", () => console.log(`Local reference API: http://127.0.0.1:${port}\nNo data is saved. No AI provider is called.`));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { server.closeAllConnections(); server.close(); });
}
