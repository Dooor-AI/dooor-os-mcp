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
import { createHash } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DooorApiClient } from "./api-client.js";
import {
  createCorrelationId,
  DooorApiRequestError,
  logInternalError,
  withCorrelationId,
} from "./error-handling.js";
import { createServer } from "./server.js";

const BASE_URL = process.env.DOOOR_BASE_URL || "https://api.os.dooor.ai/v1";
const PORT = Number(process.env.PORT) || 8080;
const HOST = "0.0.0.0";
const MAX_BODY_BYTES = 1024 * 1024;
const MCP_REQUEST_TIMEOUT_MS = 120_000;
const MAX_CONCURRENT_REQUESTS = 32;
const RATE_LIMIT_WINDOW_MS = 60_000;
// Best-effort process-local defense. The backend owns authoritative global
// limits across every MCP instance.
const RATE_LIMIT_PER_KEY = 120;
const MAX_RATE_LIMIT_BUCKETS = 20_000;

class PayloadTooLargeError extends Error {}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const rateLimitBuckets = new Map<string, RateLimitBucket>();
let lastRateLimitCleanup = 0;
let activeMcpRequests = 0;

/** JSON-RPC error envelope so MCP clients can parse failures. */
function jsonRpcError(
  res: http.ServerResponse,
  status: number,
  code: number,
  message: string,
  correlationId: string,
) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    error: { code, message, data: { correlationId } },
    id: null,
  });
  res.writeHead(status, {
    "Content-Type": "application/json",
    "X-Correlation-Id": correlationId,
  });
  res.end(body);
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  correlationId: string,
) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "X-Correlation-Id": correlationId,
  });
  res.end(JSON.stringify(payload));
}

/** Read at most 1 MiB without retaining excess chunks in memory. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      req.resume();
      reject(new PayloadTooLargeError("Request body exceeds 1 MiB"));
      return;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let exceeded = false;
    req.on("data", (chunk: Buffer | string) => {
      if (exceeded) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        exceeded = true;
        chunks.length = 0;
        reject(new PayloadTooLargeError("Request body exceeds 1 MiB"));
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (!exceeded) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function hashRateLimitKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function consumeRateLimit(key: string, limit: number): boolean {
  const now = Date.now();
  if (now - lastRateLimitCleanup >= RATE_LIMIT_WINDOW_MS) {
    for (const [bucketKey, bucket] of rateLimitBuckets) {
      if (bucket.resetAt <= now) rateLimitBuckets.delete(bucketKey);
    }
    lastRateLimitCleanup = now;
  }

  const existing = rateLimitBuckets.get(key);
  if (!existing || existing.resetAt <= now) {
    if (rateLimitBuckets.size >= MAX_RATE_LIMIT_BUCKETS) {
      const oldestKey = rateLimitBuckets.keys().next().value as
        | string
        | undefined;
      if (oldestKey) rateLimitBuckets.delete(oldestKey);
    }
    rateLimitBuckets.set(key, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    });
    return true;
  }
  if (existing.count >= limit) return false;
  existing.count += 1;
  return true;
}

async function handleMcpPost(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  correlationId: string,
) {
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
      "Unauthorized",
      correlationId,
    );
  }

  const keyRateLimitOk = consumeRateLimit(
    `key:${hashRateLimitKey(apiKey)}`,
    RATE_LIMIT_PER_KEY
  );
  if (!keyRateLimitOk) {
    res.setHeader("Retry-After", "60");
    req.resume();
    return jsonRpcError(
      res,
      429,
      -32003,
      "Rate limit exceeded. Retry later.",
      correlationId,
    );
  }

  const requestController = new AbortController();
  const deadline = setTimeout(
    () => requestController.abort(new Error("MCP request deadline exceeded")),
    MCP_REQUEST_TIMEOUT_MS
  );
  const abortOnDisconnect = () =>
    requestController.abort(new Error("MCP client disconnected"));
  const abortOnResponseClose = () => {
    if (!res.writableEnded) abortOnDisconnect();
  };
  const cleanupRequest = () => {
    clearTimeout(deadline);
    req.removeListener("aborted", abortOnDisconnect);
    res.removeListener("close", abortOnResponseClose);
  };
  req.once("aborted", abortOnDisconnect);
  res.once("close", abortOnResponseClose);

  // Parse the JSON-RPC body ourselves and hand it to the transport as
  // parsedBody (we have already consumed the request stream).
  let parsedBody: unknown;
  try {
    const raw = await readBody(req);
    parsedBody = raw ? JSON.parse(raw) : undefined;
  } catch (error) {
    cleanupRequest();
    if (error instanceof PayloadTooLargeError) {
      res.setHeader("Connection", "close");
      return jsonRpcError(
        res,
        413,
        -32000,
        "Request body exceeds the 1 MiB limit",
        correlationId,
      );
    }
    return jsonRpcError(
      res,
      400,
      -32700,
      "Parse error: request body is not valid JSON",
      correlationId,
    );
  }

  // Build a fresh, per-request client + server bound to THIS key.
  const api = new DooorApiClient(BASE_URL, apiKey, undefined, {
    signal: requestController.signal,
    requestTimeoutMs: MCP_REQUEST_TIMEOUT_MS,
  });
  try {
    await api.resolveWorkspace();
  } catch (err) {
    cleanupRequest();
    logInternalError("MCP workspace resolution failed", err, correlationId);
    if (requestController.signal.aborted) {
      return jsonRpcError(
        res,
        504,
        -32002,
        "Request timed out",
        correlationId,
      );
    }
    if (
      err instanceof DooorApiRequestError &&
      (err.status === 401 || err.status === 403)
    ) {
      return jsonRpcError(res, 401, -32001, "Unauthorized", correlationId);
    }
    if (err instanceof DooorApiRequestError && err.status === 429) {
      res.setHeader("Retry-After", "60");
      return jsonRpcError(
        res,
        429,
        -32003,
        "Rate limit exceeded. Retry later.",
        correlationId,
      );
    }
    return jsonRpcError(
      res,
      502,
      -32002,
      "Authentication service unavailable",
      correlationId,
    );
  }

  const server = createServer(api, { localFilesystemAccess: false });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  // Stateless: tear everything down when the response closes.
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await withCorrelationId(correlationId, async () => {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    });
  } catch (err) {
    logInternalError("MCP request handling failed", err, correlationId);
    if (!res.headersSent) {
      if (requestController.signal.aborted) {
        jsonRpcError(
          res,
          504,
          -32002,
          "Request timed out",
          correlationId,
        );
      } else {
        jsonRpcError(
          res,
          500,
          -32603,
          "Internal server error",
          correlationId,
        );
      }
    }
  } finally {
    cleanupRequest();
  }
}

async function dispatchMcpPost(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  correlationId: string,
): Promise<void> {
  if (activeMcpRequests >= MAX_CONCURRENT_REQUESTS) {
    res.setHeader("Retry-After", "1");
    req.resume();
    jsonRpcError(
      res,
      503,
      -32004,
      "Server is at the concurrent request limit. Retry shortly.",
      correlationId,
    );
    return;
  }

  activeMcpRequests += 1;
  try {
    await handleMcpPost(req, res, correlationId);
  } catch (error) {
    logInternalError("MCP request dispatch failed", error, correlationId);
    if (!res.headersSent) {
      jsonRpcError(
        res,
        500,
        -32603,
        "Internal server error",
        correlationId,
      );
    }
  } finally {
    activeMcpRequests -= 1;
  }
}

const httpServer = http.createServer((req, res) => {
  const correlationId = createCorrelationId();
  res.setHeader("X-Correlation-Id", correlationId);
  const path = (req.url ?? "/").split("?")[0];

  // External health check. /healthz is kept for compatibility, but some Google
  // front ends reserve that path before the request reaches the container.
  if (req.method === "GET" && (path === "/health" || path === "/healthz")) {
    return sendJson(res, 200, { status: "ok" }, correlationId);
  }

  if (path === "/mcp") {
    if (req.method === "POST") {
      void dispatchMcpPost(req, res, correlationId);
      return;
    }
    // Stateless mode has no standalone SSE stream and no session to delete.
    if (req.method === "GET" || req.method === "DELETE") {
      res.setHeader("Allow", "POST");
      return jsonRpcError(
        res,
        405,
        -32000,
        "Method not allowed (stateless server: use POST /mcp)",
        correlationId,
      );
    }
    res.setHeader("Allow", "POST");
    return jsonRpcError(
      res,
      405,
      -32000,
      "Method not allowed",
      correlationId,
    );
  }

  return sendJson(res, 404, { error: "Not found" }, correlationId);
});

httpServer.requestTimeout = MCP_REQUEST_TIMEOUT_MS + 5_000;
httpServer.headersTimeout = 15_000;
httpServer.keepAliveTimeout = 5_000;

httpServer.listen(PORT, HOST, () => {
  console.error(
    `Dooor MCP HTTP server listening on http://${HOST}:${PORT} (POST /mcp, GET /healthz)`
  );
});
