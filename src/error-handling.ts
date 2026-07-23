import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

interface RequestContext {
  correlationId: string;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

/** Strip anything credential-shaped and bound the length of untrusted text. */
export function redactSensitive(raw: string, maxLength = 1_000): string {
  return raw
    .replace(/dor_sk_[A-Za-z0-9._~-]+/g, "[REDACTED_API_KEY]")
    .replace(/(authorization|x-api-key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, maxLength);
}

/*
 * A public 4xx can explain a caller mistake, but it must not expose the
 * backend's physical layout. These patterns intentionally describe shapes,
 * not customer names, so this public repository never becomes a registry of
 * private tenants.
 */
const INTERNAL_DETAIL_PATTERNS: readonly RegExp[] = [
  /\[[^\]\r\n]{1,80}(?:ch|adapter|provider|runtime|service|repository|client|driver|connector)\]/i,
  /\b[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*(?:[-_](?:adapter|runtime|provider|connector|driver|repository))\b/i,
  /\b(?:gold|silver|bronze|landing|staging|raw)_[a-z0-9_]+\b/i,
  /\b[a-z][a-z0-9]*_conn_[a-z0-9_]+\b/i,
  /\b(?:relation|table|view|schema|database|dataset)\s+["'`][^"'`\r\n]{1,128}["'`]/i,
  /\b(?:relation|table|view)\s+[a-z][a-z0-9]*(?:[._][a-z0-9]+)+\b/i,
  /\b(?:adapterKey|primaryRuntime|connectionString|databaseUrl|dataSourceId)\b/i,
  /\b(?:https?|postgres(?:ql)?|clickhouse|redis|mongodb|mysql):\/\/[^\s]+/i,
  /\b(?:host|hostname|port|database|schema|dataset|project(?:_id)?)\s*[:=]\s*["']?[^\s,;]+/i,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  /\b[a-z0-9.-]+\.internal\b/i,
  /\b(?:clickhouse|postgres(?:ql)?|redis|cloud\s*run|cloud\s*sql|kubernetes|k8s|minio|qdrant)\b/i,
];

/**
 * Keep a useful validation or governance reason only when it is neutral.
 * Discard the whole detail when any internal marker appears: partial
 * replacement can leave an identifying prefix or enough context to infer it.
 */
function sanitizePublicDetail(
  raw: string,
  maxLength = 300,
): string | undefined {
  const clean = redactSensitive(raw, maxLength).trim();
  if (!clean) return undefined;
  if (INTERNAL_DETAIL_PATTERNS.some((pattern) => pattern.test(clean))) {
    return undefined;
  }
  return clean;
}

/**
 * Sanitized upstream failure.
 *
 * Bodies of 5xx responses are deliberately discarded: a server fault can carry
 * a stack trace, a connection string or a secret, and none of that belongs in a
 * client-facing message. A 4xx is different in kind, it describes what the
 * caller got wrong, so the caller is exactly who needs to read it. Only a
 * neutral detail without physical or infrastructure metadata is retained.
 */
export class DooorApiRequestError extends Error {
  readonly detail?: string;

  constructor(readonly status: number, detail?: string) {
    super("Dooor API request failed");
    this.name = "DooorApiRequestError";
    if (detail && status < 500) {
      const clean = sanitizePublicDetail(detail);
      if (clean) this.detail = clean;
    }
  }
}

/** Always create the ID locally. Never echo a caller-provided request ID. */
export function createCorrelationId(): string {
  return randomUUID();
}

export function withCorrelationId<T>(
  correlationId: string,
  action: () => T,
): T {
  return requestContext.run({ correlationId }, action);
}

export function currentCorrelationId(): string {
  return requestContext.getStore()?.correlationId ?? createCorrelationId();
}

export function publicErrorMessage(error: unknown): string {
  if (!(error instanceof DooorApiRequestError)) return "Request failed";

  if (error.status === 401) {
    return "Request is not authorized";
  }
  if (error.status === 403) {
    // A 403 from the backend is a governance decision (scope, source coverage,
    // lineage) whose reason the caller must read to fix their setup. Masking it
    // sent a real client chasing "missing scopes" that were never the problem.
    return error.detail ?? "Request is not authorized";
  }
  if (error.status === 404) return "Requested resource was not found";
  if (error.status === 409) {
    return "Request could not be completed due to a conflict";
  }
  if (error.status === 429) return "Backend rate limit exceeded. Retry later";
  if (error.status >= 500) return "Backend service is unavailable";
  // A rejected request is the caller's to fix, so say what was wrong with it.
  if (error.detail) return error.detail;
  if (error.status === 400) return "Request was rejected as invalid";
  return "Request failed";
}

export function publicFailure(
  error: unknown,
  correlationId = currentCorrelationId(),
): { error: string; correlationId: string } {
  return {
    error: publicErrorMessage(error),
    correlationId,
  };
}

/**
 * Keep logs useful without copying credentials or an unbounded error payload.
 * Upstream errors contain only their status because the response body is never
 * retained by DooorApiRequestError.
 */
export function safeErrorSummary(error: unknown): string {
  if (error instanceof DooorApiRequestError) {
    const base = `${error.name} status=${error.status}`;
    // Already sanitized and bounded by the constructor, and only ever set for
    // a 4xx, so this cannot reintroduce an upstream internal identifier.
    return error.detail ? `${base} detail=${error.detail}` : base;
  }

  const raw =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : "Unknown error";

  return redactSensitive(raw);
}

export function logInternalError(
  scope: string,
  error: unknown,
  correlationId = currentCorrelationId(),
): void {
  console.error(
    `[correlation_id=${correlationId}] ${scope}: ${safeErrorSummary(error)}`,
  );
}
