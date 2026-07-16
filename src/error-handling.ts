import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

interface RequestContext {
  correlationId: string;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

/** Sanitized upstream failure. Response bodies are deliberately discarded. */
export class DooorApiRequestError extends Error {
  constructor(readonly status: number) {
    super("Dooor API request failed");
    this.name = "DooorApiRequestError";
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
    return `${error.name} status=${error.status}`;
  }

  const raw =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : "Unknown error";

  return raw
    .replace(/dor_sk_[A-Za-z0-9._~-]+/g, "[REDACTED_API_KEY]")
    .replace(/(authorization|x-api-key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 1_000);
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
