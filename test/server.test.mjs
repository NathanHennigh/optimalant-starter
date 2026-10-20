import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { createServer } from "../src/server.mjs";

const fixture = JSON.parse(await readFile(new URL("../fixtures/evening-routine.json", import.meta.url), "utf8"));

test("local HTTP API", async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const post = (body = fixture, headers = {}) => fetch(`${base}/v1/evaluations`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body),
  });

  await t.test("health names its local reference mode", async () => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).mode, "local-reference");
  });

  await t.test("valid input produces deterministic data without storing it", async () => {
    const response = await post();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    const result = await response.json();
    assert.equal(result.evaluation.currentStreak, 2);
    assert.equal(result.persisted, false);
  });

  await t.test("invalid schema returns a useful field, never a stack", async () => {
    const response = await post({ ...fixture, checkIn: { date: fixture.throughDate, completedActions: ["invented"] } });
    assert.equal(response.status, 422);
    const result = await response.json();
    assert.equal(result.error.field, "checkIn.completedActions");
    assert.equal(result.error.code, "invalid_input");
    assert.equal(result.error.stack, undefined);
  });

  await t.test("malformed JSON returns 400", async () => {
    const response = await post("{");
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "invalid_json");
  });

  await t.test("wrong content type returns 415", async () => {
    const response = await post(fixture, { "Content-Type": "text/plain" });
    assert.equal(response.status, 415);
    await response.arrayBuffer();
  });

  await t.test("compressed bodies are not accepted", async () => {
    const response = await post(fixture, { "Content-Encoding": "gzip" });
    assert.equal(response.status, 415);
    await response.arrayBuffer();
  });

  await t.test("oversized request returns 413", async () => {
    const response = await post(JSON.stringify({ text: "x".repeat(17_000) }));
    assert.equal(response.status, 413);
    await response.arrayBuffer();
  });

  await t.test("chunked bodies also enforce the byte limit", async () => {
    const status = await new Promise((resolve, reject) => {
      const request = http.request(`${base}/v1/evaluations`, { method: "POST", headers: { "Content-Type": "application/json" } }, response => { response.resume(); resolve(response.statusCode); });
      request.on("error", reject);
      request.write("x".repeat(9_000));
      request.end("x".repeat(9_000));
    });
    assert.equal(status, 413);
  });

  await t.test("foreign origins are rejected", async () => {
    const response = await post(fixture, { Origin: "https://untrusted.example" });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "invalid_origin");
  });

  await t.test("foreign hostnames are rejected", async () => {
    const result = await new Promise((resolve, reject) => {
      const request = http.request(`${base}/health`, { headers: { Host: "untrusted.example" } }, response => {
        let body = "";
        response.on("data", chunk => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, "invalid_host");
  });

  await t.test("unknown endpoints and wrong methods are explicit", async () => {
    const missing = await fetch(`${base}/v1/users`);
    assert.equal(missing.status, 404);
    await missing.arrayBuffer();
    const method = await fetch(`${base}/v1/evaluations`);
    assert.equal(method.status, 405);
    assert.equal(method.headers.get("allow"), "POST");
    await method.arrayBuffer();
  });
});
