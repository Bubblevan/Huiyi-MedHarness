import { createServer, request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { pathToFileURL } from "node:url";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const PUBLIC_PATHS = new Set([
  "GET /api/health",
  "POST /api/auth/login",
  "GET /api/auth/session",
  "POST /api/auth/logout",
]);

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
  });
  response.end(JSON.stringify(body));
}

function normalizeOrigin(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError(`${label} must be an absolute URL`); }
  if (!(["https:", "http:"].includes(url.protocol)) || url.origin !== value.replace(/\/$/, "") || url.username || url.password) {
    throw new TypeError(`${label} must be an origin without credentials, path, query, or fragment`);
  }
  if (url.protocol !== "https:" && process.env.NODE_ENV === "production") {
    throw new TypeError(`${label} must use HTTPS in production`);
  }
  return url.origin;
}

function upstreamRequest(upstream, path, options = {}) {
  return new Promise((resolve, reject) => {
    const transport = upstream.protocol === "https:" ? requestHttps : requestHttp;
    const request = transport(new URL(path, upstream), options, (response) => resolve(response));
    request.once("error", reject);
    if (options.timeout) request.setTimeout(options.timeout, () => request.destroy(new Error("UPSTREAM_TIMEOUT")));
    if (options.body) request.end(options.body);
    else request.end();
  });
}

function setSecurityHeaders(response) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "same-origin");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("cache-control", "no-store");
}

export function createEdgeAuthServer({
  upstreamUrl = process.env.HUIYI_GATEWAY_UPSTREAM,
  externalOrigin = process.env.HUIYI_PUBLIC_ORIGIN,
  environmentName = process.env.HUIYI_PUBLIC_ENVIRONMENT ?? "临床评测环境",
  providerName = process.env.HUIYI_PUBLIC_PROVIDER ?? "",
  modelName = process.env.HUIYI_PUBLIC_MODEL ?? "",
  version = process.env.HUIYI_PUBLIC_VERSION ?? "local",
  auditUrl = process.env.HUIYI_PUBLIC_AUDIT_URL ?? "",
} = {}) {
  if (!upstreamUrl) throw new TypeError("HUIYI_GATEWAY_UPSTREAM is required");
  if (!externalOrigin) throw new TypeError("HUIYI_PUBLIC_ORIGIN is required");
  const upstream = new URL(upstreamUrl);
  if (!(["http:", "https:"].includes(upstream.protocol)) || upstream.username || upstream.password) {
    throw new TypeError("HUIYI_GATEWAY_UPSTREAM must be HTTP(S) without embedded credentials");
  }
  const trustedOrigin = normalizeOrigin(externalOrigin, "HUIYI_PUBLIC_ORIGIN");

  return createServer(async (incoming, response) => {
    setSecurityHeaders(response);
    const method = incoming.method ?? "GET";
    const parsed = new URL(incoming.url ?? "/", "http://edge-auth.invalid");

    if (method === "GET" && parsed.pathname === "/healthz") {
      json(response, 200, { status: "ok", component: "edge-auth" });
      return;
    }

    if (method === "GET" && parsed.pathname === "/runtime-config.js") {
      let resolvedProvider = providerName;
      let resolvedModel = modelName;
      if (!resolvedProvider || !resolvedModel) {
        try {
          const health = await upstreamRequest(upstream, "/api/health", { method: "GET", headers: { accept: "application/json" }, timeout: 2_000 });
          let body = "";
          for await (const chunk of health) body += chunk;
          if (health.statusCode === 200) {
            const runtime = JSON.parse(body);
            resolvedProvider ||= typeof runtime.providerName === "string" ? runtime.providerName : runtime.modelBackend;
            resolvedModel ||= typeof runtime.modelName === "string" ? runtime.modelName : "";
          }
        } catch { /* Provider metadata is optional and contains no request data. */ }
      }
      const config = {
        environmentName,
        ...(resolvedProvider ? { providerName: resolvedProvider } : {}),
        ...(resolvedModel ? { modelName: resolvedModel } : {}),
        version,
        ...(auditUrl ? { auditUrl } : {}),
      };
      response.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(`window.HuiyiRuntimeConfig = Object.freeze(${JSON.stringify(config)});\n`);
      return;
    }

    if (!parsed.pathname.startsWith("/api/")) {
      json(response, 404, { error: "NOT_FOUND" });
      return;
    }

    const cookie = incoming.headers.cookie;
    const publicRoute = PUBLIC_PATHS.has(`${method} ${parsed.pathname}`);
    const suppliedOrigin = incoming.headers.origin;
    if (suppliedOrigin && suppliedOrigin !== trustedOrigin) {
      json(response, 403, { error: "ORIGIN_NOT_ALLOWED" });
      return;
    }
    if (!SAFE_METHODS.has(method) && suppliedOrigin !== trustedOrigin) {
      json(response, 403, { error: "ORIGIN_REQUIRED" });
      return;
    }

    if (!publicRoute) {
      if (!cookie) {
        json(response, 401, { error: "AUTH_REQUIRED" });
        return;
      }
      let session;
      try {
        session = await upstreamRequest(upstream, "/api/auth/session", {
          method: "GET",
          headers: { cookie, accept: "application/json" },
          timeout: 3_000,
        });
      } catch {
        json(response, 502, { error: "GATEWAY_UNAVAILABLE" });
        return;
      }
      session.resume();
      if (session.statusCode !== 200) {
        json(response, session.statusCode === 401 ? 401 : 502, { error: session.statusCode === 401 ? "AUTH_REQUIRED" : "GATEWAY_UNAVAILABLE" });
        return;
      }
    }

    const headers = { ...incoming.headers };
    delete headers.connection;
    delete headers["content-length"];
    headers.host = upstream.host;
    headers.origin = trustedOrigin;
    headers["x-forwarded-host"] = incoming.headers.host ?? new URL(trustedOrigin).host;
    headers["x-forwarded-proto"] = new URL(trustedOrigin).protocol.slice(0, -1);
    const transport = upstream.protocol === "https:" ? requestHttps : requestHttp;
    const outgoing = transport(new URL(`${parsed.pathname}${parsed.search}`, upstream), { method, headers }, (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers };
      delete responseHeaders.connection;
      delete responseHeaders["transfer-encoding"];
      responseHeaders["x-content-type-options"] = "nosniff";
      responseHeaders["x-frame-options"] = "DENY";
      responseHeaders["referrer-policy"] = "same-origin";
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      upstreamResponse.pipe(response);
    });
    outgoing.once("error", () => {
      if (response.headersSent) response.destroy();
      else json(response, 502, { error: "GATEWAY_UNAVAILABLE" });
    });
    incoming.once("aborted", () => outgoing.destroy());
    response.once("close", () => { if (!response.writableEnded) outgoing.destroy(); });
    incoming.pipe(outgoing);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8081);
  const host = process.env.HOST ?? "0.0.0.0";
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("PORT must be a valid TCP port");
  const server = createEdgeAuthServer();
  server.listen(port, host, () => process.stdout.write(`Edge auth proxy listening on ${host}:${port}\n`));
}
