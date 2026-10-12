import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test, { after, before } from "node:test";
import { createEdgeAuthServer } from "./server.mjs";

const trustedOrigin = "https://localhost:8443";
let upstream;
let proxy;
let baseUrl;
let upstreamCalls;

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

before(async () => {
  upstreamCalls = [];
  upstream = createServer((request, response) => {
    upstreamCalls.push({ method: request.method, url: request.url, cookie: request.headers.cookie, origin: request.headers.origin });
    if (request.url === "/api/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", providerName: "synthetic-provider", modelName: "synthetic-model" }));
      return;
    }
    if (request.url === "/api/auth/session") {
      const authenticated = request.headers.cookie === "huiyi_eval_session=valid";
      response.writeHead(authenticated ? 200 : 401, { "content-type": "application/json" });
      response.end(JSON.stringify({ authenticated }));
      return;
    }
    if (request.url === "/api/auth/login") {
      response.writeHead(200, { "content-type": "application/json", "set-cookie": "huiyi_eval_session=valid; HttpOnly; SameSite=Strict" });
      response.end('{"authenticated":true}');
      return;
    }
    if (request.url === "/api/chat") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-run-id": "synthetic-run" });
      response.write("event: assistant.delta\ndata: {\"text\":\"first\"}\n\n");
      setTimeout(() => {
        response.write("event: run.completed\ndata: {\"status\":\"completed\"}\n\n");
        response.end();
      }, 15);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const upstreamPort = await listen(upstream);
  proxy = createEdgeAuthServer({ upstreamUrl: `http://127.0.0.1:${upstreamPort}`, externalOrigin: trustedOrigin });
  const proxyPort = await listen(proxy);
  baseUrl = `http://127.0.0.1:${proxyPort}`;
});

after(async () => {
  for (const server of [proxy, upstream]) {
    if (!server?.listening) continue;
    server.close();
    await once(server, "close");
  }
});

test("health metadata is served without exposing Gateway response content", async () => {
  const response = await fetch(`${baseUrl}/runtime-config.js`);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /synthetic-provider/);
  assert.match(body, /synthetic-model/);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
});

test("protected Gateway requests require a live identity before proxying", async () => {
  const start = upstreamCalls.length;
  const anonymous = await fetch(`${baseUrl}/api/chat`, { method: "POST", headers: { origin: trustedOrigin } });
  assert.equal(anonymous.status, 401);
  assert.equal(upstreamCalls.length, start);

  const revoked = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { origin: trustedOrigin, cookie: "huiyi_eval_session=expired" },
  });
  assert.equal(revoked.status, 401);
  assert.equal(upstreamCalls.filter((call) => call.url === "/api/chat").length, 0);
});

test("same-origin login is forwarded and retains the Gateway session cookie", async () => {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { origin: trustedOrigin, "content-type": "application/json" },
    body: JSON.stringify({ username: "synthetic-clinician", password: "not-a-real-secret" }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly/);
  assert.equal(upstreamCalls.at(-1)?.origin, trustedOrigin);
});

test("authenticated SSE is streamed through the edge with security headers", async () => {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: {
      origin: trustedOrigin,
      cookie: "huiyi_eval_session=valid",
      "content-type": "application/json",
    },
    body: JSON.stringify({ message: "synthetic prompt only" }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.equal(response.headers.get("x-run-id"), "synthetic-run");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  const body = await response.text();
  assert.match(body, /assistant\.delta/);
  assert.match(body, /run\.completed/);
  assert.equal(upstreamCalls.at(-1)?.cookie, "huiyi_eval_session=valid");
  assert.equal(upstreamCalls.at(-1)?.origin, trustedOrigin);
});

test("cross-origin mutation and non-API paths are rejected", async () => {
  const denied = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { origin: "https://attacker.invalid", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(denied.status, 403);
  const missing = await fetch(`${baseUrl}/not-an-api-route`);
  assert.equal(missing.status, 404);
});
