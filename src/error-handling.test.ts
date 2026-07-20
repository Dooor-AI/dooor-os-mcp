import assert from "node:assert/strict";
import test from "node:test";
import { DooorApiClient } from "./api-client.js";
import {
  createCorrelationId,
  currentCorrelationId,
  DooorApiRequestError,
  publicErrorMessage,
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

test("surfaces a 4xx body so the caller learns what was wrong", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        statusCode: 400,
        message: 'Coluna inexistente: column "gapValue" does not exist',
      }),
      { status: 400 },
    );

  try {
    const api = new DooorApiClient("https://example.invalid", "dor_sk_test");
    await assert.rejects(api.resolveWorkspace(), (error: unknown) => {
      assert.ok(error instanceof DooorApiRequestError);
      assert.equal(error.status, 400);
      assert.match(error.detail ?? "", /Coluna inexistente/);
      assert.match(publicErrorMessage(error), /gapValue/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("still discards a 5xx body even though 4xx bodies are read", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ message: "postgres password is hunter2" }), {
      status: 500,
    });

  try {
    const api = new DooorApiClient("https://example.invalid", "dor_sk_test");
    await assert.rejects(api.resolveWorkspace(), (error: unknown) => {
      assert.ok(error instanceof DooorApiRequestError);
      assert.equal(error.detail, undefined);
      assert.equal(
        publicErrorMessage(error),
        "Backend service is unavailable",
      );
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("redacts a credential that appears inside a 4xx body", () => {
  const error = new DooorApiRequestError(
    400,
    "rejected key dor_sk_fakeKeyForRedactionTest for workspace",
  );

  assert.doesNotMatch(error.detail ?? "", /dor_sk_fakeKeyForRedactionTest/);
  assert.match(error.detail ?? "", /REDACTED_API_KEY/);
  assert.doesNotMatch(safeErrorSummary(error), /dor_sk_fakeKeyForRedactionTest/);
});

test("never retains a detail for a server fault", () => {
  const error = new DooorApiRequestError(503, "internal stack trace");

  assert.equal(error.detail, undefined);
});

test("keeps authorization-shaped errors generic rather than echoing the body", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ message: "token abc is expired" }), {
      status: 401,
    });

  try {
    const api = new DooorApiClient("https://example.invalid", "dor_sk_test");
    await assert.rejects(api.resolveWorkspace(), (error: unknown) => {
      assert.equal(
        publicErrorMessage(error),
        "Request is not authorized",
      );
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
