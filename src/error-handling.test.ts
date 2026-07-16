import assert from "node:assert/strict";
import test from "node:test";
import { DooorApiClient } from "./api-client.js";
import {
  createCorrelationId,
  currentCorrelationId,
  DooorApiRequestError,
  publicFailure,
  safeErrorSummary,
  withCorrelationId,
} from "./error-handling.js";

test("creates server-owned UUID correlation IDs", () => {
  const first = createCorrelationId();
  const second = createCorrelationId();

  assert.match(
    first,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.notEqual(first, second);
});

test("propagates the correlation ID through asynchronous work", async () => {
  const correlationId = createCorrelationId();

  await withCorrelationId(correlationId, async () => {
    await Promise.resolve();
    assert.equal(currentCorrelationId(), correlationId);
  });
});

test("discards an upstream response body before creating an error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("database password and stack trace", { status: 502 });

  try {
    const api = new DooorApiClient("https://example.invalid", "dor_sk_test");
    await assert.rejects(api.resolveWorkspace(), (error: unknown) => {
      assert.ok(error instanceof DooorApiRequestError);
      assert.equal(error.status, 502);
      assert.doesNotMatch(error.message, /database password|stack trace/i);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns a stable public error with its correlation ID", () => {
  const correlationId = createCorrelationId();
  const failure = publicFailure(
    new DooorApiRequestError(502),
    correlationId,
  );

  assert.deepEqual(failure, {
    error: "Backend service is unavailable",
    correlationId,
  });
  assert.doesNotMatch(JSON.stringify(failure), /database password|stack trace/i);
});

test("redacts API keys and auth headers from internal log summaries", () => {
  const summary = safeErrorSummary(
    new Error(
      "dor_sk_super-secret Authorization: Bearer-secret X-Api-Key=dor_sk_second",
    ),
  );

  assert.doesNotMatch(summary, /super-secret|Bearer-secret|dor_sk_second/);
  assert.match(summary, /REDACTED/);
});
