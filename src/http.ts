#!/usr/bin/env node

/**
 * Remote (hosted) MCP entrypoint.
 *
 * Exposes the same tool registry as the stdio server (src/index.ts) over HTTP
 * using the MCP SDK's StreamableHTTPServerTransport in STATELESS mode.
 *
 * Auth is per-request: the API key is read from the incoming
 * `Authorization: Bearer dor_sk_...` header, NOT from the environment. Each
 * request builds its own ApiClient (and therefore its own MCP Server), so the
 * per-client data isolation that the stdio mode gets from a dedicated process
 * is preserved across many concurrent clients hitting one hosted instance.
 *
 * Routes:
 *   POST   /mcp      -> handle one JSON-RPC request (stateless)
 *   GET    /mcp      -> 405 (no server-initiated SSE stream in stateless mode)
 *   DELETE /mcp      -> 405 (no session to terminate in stateless mode)
 *   GET    /health   -> 200 { status: "ok" }  (external health check)
 *   GET    /healthz  -> 200 { status: "ok" }  (kept for internal compatibility)
 */

import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DooorApiClient } from "./api-client.js";
import { createServer } from "./server.js";

const BASE_URL = process.env.DOOOR_BASE_URL || "https://api.os.dooor.ai/v1";
const PORT = Number(process.env.PORT) || 8080;
const HOST = "0.0.0.0";

/** JSON-RPC error envelope so MCP clients can parse failures. */
function jsonRpcError(res: http.ServerResponse, status: number, code: number, message: string) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/** Read the full request body as a string. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleMcpPost(req: http.IncomingMessage, res: http.ServerResponse) {
  // --- Per-request auth: key comes from the request, never from env ---
  // Prefer X-Api-Key. On Cloud Run, an `Authorization: Bearer <token>` header is
  // validated as a Google IAM token by the front end and rejected (401) before
  // it reaches this container, so the workspace key travels in X-Api-Key.
  // `Authorization: Bearer dor_sk_...` is still accepted for setups that forward
  // it untouched (e.g. behind a load balancer).
  const xApiKeyRaw = req.headers["x-api-key"];
  const xApiKey = Array.isArray(xApiKeyRaw) ? xApiKeyRaw[0] : xApiKeyRaw;
  const authHeader = req.headers["authorization"];
  let apiKey: string | undefined;
  if (typeof xApiKey === "string" && /^dor_sk_/.test(xApiKey.trim())) {
    apiKey = xApiKey.trim();
  } else if (
    typeof authHeader === "string" &&
    /^Bearer\s+dor_sk_/.test(authHeader)
  ) {
    apiKey = authHeader.replace(/^Bearer\s+/, "").trim();
  }
  if (!apiKey) {
    return jsonRpcError(
      res,
      401,
      -32001,
      "Unauthorized: provide the workspace API key via 'X-Api-Key: dor_sk_...' (or 'Authorization: Bearer dor_sk_...').",
    );
  }

  // Parse the JSON-RPC body ourselves and hand it to the transport as
  // parsedBody (we have already consumed the request stream).
  let parsedBody: unknown;
  try {
    const raw = await readBody(req);
    parsedBody = raw ? JSON.parse(raw) : undefined;
  } catch {
    return jsonRpcError(res, 400, -32700, "Parse error: request body is not valid JSON");
  }

  // Build a fresh, per-request client + server bound to THIS key.
  const api = new DooorApiClient(BASE_URL, apiKey);
  try {
    await api.resolveWorkspace();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonRpcError(res, 401, -32001, `Unauthorized: ${msg}`);
  }

  const server = createServer(api);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  // Stateless: tear everything down when the response closes.
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      jsonRpcError(res, 500, -32603, `Internal error: ${msg}`);
    }
  }
}

const httpServer = http.createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];

  // External health check. /healthz is kept for compatibility, but some Google
  // front ends reserve that path before the request reaches the container.
  if (req.method === "GET" && (path === "/health" || path === "/healthz")) {
    return sendJson(res, 200, { status: "ok" });
  }

  if (path === "/mcp") {
    if (req.method === "POST") {
      void handleMcpPost(req, res);
      return;
    }
    // Stateless mode has no standalone SSE stream and no session to delete.
    if (req.method === "GET" || req.method === "DELETE") {
      res.setHeader("Allow", "POST");
      return jsonRpcError(res, 405, -32000, "Method not allowed (stateless server: use POST /mcp)");
    }
    res.setHeader("Allow", "POST");
    return jsonRpcError(res, 405, -32000, "Method not allowed");
  }

  return sendJson(res, 404, { error: "Not found" });
});

httpServer.listen(PORT, HOST, () => {
  console.error(`Dooor MCP HTTP server listening on http://${HOST}:${PORT} (POST /mcp, GET /healthz)`);
});
