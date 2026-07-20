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

/**
 * Sanitized upstream failure.
 *
 * Bodies of 5xx responses are deliberately discarded: a server fault can carry
 * a stack trace, a connection string or a secret, and none of that belongs in a
 * client-facing message. A 4xx is different in kind, it describes what the
 * caller got wrong, so the caller is exactly who needs to read it. Only that
 * class of response may supply `detail`, and only after redaction.
 */
export class DooorApiRequestError extends Error {
  readonly detail?: string;

  constructor(readonly status: number, detail?: string) {
    super("Dooor API request failed");
    this.name = "DooorApiRequestError";
    if (detail && status < 500) {
      const clean = redactSensitive(detail, 300).trim();
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

  if (error.status === 401 || error.status === 403) {
    return "Request is not authorized";
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
    // Already redacted and bounded by the constructor, and only ever set for
    // a 4xx, so this cannot reintroduce a server-side payload into the logs.
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
