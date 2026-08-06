import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { DooorApiClient } from "./api-client.js";
import {
  createServer,
  enabledProductToolsFrom,
  type CreateServerOptions,
} from "./server.js";

async function listToolDefinitions(options?: CreateServerOptions) {
  const server = createServer({} as DooorApiClient, options);
  const client = new Client(
    { name: "dooor-mcp-server-test", version: "1.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.listTools();
    return response.tools;
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

async function getServerInstructions(options?: CreateServerOptions) {
  const server = createServer({} as DooorApiClient, options);
  const client = new Client(
    { name: "dooor-mcp-instructions-test", version: "1.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client.getInstructions() ?? "";
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

async function listToolNames(options?: CreateServerOptions): Promise<string[]> {
  return (await listToolDefinitions(options)).map((tool) => tool.name);
}

async function callCapabilities(
  api: Partial<DooorApiClient>,
  includeProbes?: boolean,
) {
  const server = createServer(api as DooorApiClient);
  const client = new Client(
    { name: "dooor-mcp-capabilities-test", version: "1.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({
      name: "capabilities",
      arguments: includeProbes === undefined ? {} : { includeProbes },
    });
    const content = (
      response as { content: Array<{ type: string; text?: string }> }
    ).content;
    const text = content.find((item) => item.type === "text");
    assert.equal(text?.type, "text");
    assert.equal(typeof text?.text, "string");
    if (!text?.text) throw new Error("capabilities returned no text content");
    return JSON.parse(text.text) as {
      toolFamilies: Array<{
        family: string;
        tools: string[];
        availability: string;
      }>;
      probes: Array<{ name: string; ok: boolean; data?: unknown }>;
    };
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

test("remote mode does not register filesystem deployment tools", async () => {
  const tools = await listToolNames({ localFilesystemAccess: false });

  assert.equal(tools.includes("deploy_app_from_directory"), false);
  assert.equal(tools.includes("deploy_app_from_tarball"), false);
});

test("filesystem deployment tools fail closed by default", async () => {
  const tools = await listToolNames();

  assert.equal(tools.includes("deploy_app_from_directory"), false);
  assert.equal(tools.includes("deploy_app_from_tarball"), false);
});

test("trusted local mode explicitly enables filesystem deployment tools", async () => {
  const tools = await listToolNames({ localFilesystemAccess: true });

  assert.equal(tools.includes("deploy_app_from_directory"), true);
  assert.equal(tools.includes("deploy_app_from_tarball"), true);
});

test("hosted mode registers the agent-driven upload deploy pair", async () => {
  const tools = await listToolNames({ localFilesystemAccess: false });

  assert.equal(tools.includes("deploy_app_upload_init"), true);
  assert.equal(tools.includes("deploy_app_upload_finalize"), true);
});

test("registers managed platform domain tools in hosted mode", async () => {
  const tools = await listToolNames({ localFilesystemAccess: false });

  assert.equal(tools.includes("get_app_platform_domain"), true);
  assert.equal(tools.includes("set_app_platform_domain"), true);
  assert.equal(tools.includes("remove_app_platform_domain"), true);
});

test("set_app_platform_domain forwards the app id and label", async () => {
  const api = {
    setAppPlatformDomain: async (appId: string, subdomain: string) => {
      assert.equal(appId, "app-1");
      assert.equal(subdomain, "finance-copilot");
      return {
        domain: "finance-copilot.apps.dooor.ai",
        status: "TLS_ISSUING",
        dnsRequired: false,
      };
    },
  } as Partial<DooorApiClient>;
  const server = createServer(api as DooorApiClient, {
    localFilesystemAccess: false,
  });
  const client = new Client(
    { name: "dooor-mcp-platform-domain-test", version: "1.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({
      name: "set_app_platform_domain",
      arguments: { appId: "app-1", subdomain: "finance-copilot" },
    });
    const text = (
      response as { content: Array<{ type: string; text?: string }> }
    ).content.find((item) => item.type === "text")?.text;
    const parsed = JSON.parse(text ?? "{}");
    assert.equal(parsed.domain, "finance-copilot.apps.dooor.ai");
    assert.equal(parsed.status, "TLS_ISSUING");
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
});

test("upload init returns the presigned slot plus next steps for the agent", async () => {
  const api = {
    initUpload: async (appId: string, data: { sizeBytes: number; sha256?: string }) => {
      assert.equal(appId, "app-1");
      assert.equal(data.sizeBytes, 489);
      assert.equal(
        data.sha256,
        "a".repeat(64),
      );
      return {
        uploadId: "up-1",
        bucketKey: "workspaces/ws/apps/app-1/uploads/up-1.tar.gz",
        presignedPutUrl: "https://storage.example/put",
        headers: { "content-type": "application/gzip" },
        expiresAt: "2026-01-01T00:00:00.000Z",
        maxSizeBytes: 500 * 1024 * 1024,
      };
    },
  } as Partial<DooorApiClient>;
  const server = createServer(api as DooorApiClient, {
    localFilesystemAccess: false,
  });
  const client = new Client(
    { name: "dooor-mcp-upload-init-test", version: "1.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({
      name: "deploy_app_upload_init",
      arguments: { appId: "app-1", sizeBytes: 489, sha256: "a".repeat(64) },
    });
    const text = (
      response as { content: Array<{ type: string; text?: string }> }
    ).content.find((item) => item.type === "text")?.text;
    const parsed = JSON.parse(text ?? "{}");
    assert.equal(parsed.uploadId, "up-1");
    assert.equal(parsed.presignedPutUrl, "https://storage.example/put");
    assert.equal(Array.isArray(parsed.nextSteps), true);
    assert.match(parsed.nextSteps.join(" "), /PUT/);
    assert.match(parsed.nextSteps.join(" "), /deploy_app_upload_finalize/);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
});

test("upload finalize completes the upload then triggers an UPLOAD deploy", async () => {
  const calls: string[] = [];
  const api = {
    completeUpload: async (
      appId: string,
      uploadId: string,
      data: { sha256: string },
    ) => {
      calls.push("complete");
      assert.equal(appId, "app-1");
      assert.equal(uploadId, "up-1");
      assert.equal(data.sha256, "b".repeat(64));
      return { uploadId, status: "UPLOADED", sizeBytes: 489 };
    },
    triggerDeploy: async (data: {
      appId: string;
      source?: { type: string; uploadId?: string };
    }) => {
      calls.push("deploy");
      assert.equal(data.appId, "app-1");
      assert.deepEqual(data.source, { type: "UPLOAD", uploadId: "up-1" });
      return { id: "dep-1", buildStatus: "PENDING" };
    },
  } as Partial<DooorApiClient>;
  const server = createServer(api as DooorApiClient, {
    localFilesystemAccess: false,
  });
  const client = new Client(
    { name: "dooor-mcp-upload-finalize-test", version: "1.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({
      name: "deploy_app_upload_finalize",
      arguments: { appId: "app-1", uploadId: "up-1", sha256: "b".repeat(64) },
    });
    const text = (
      response as { content: Array<{ type: string; text?: string }> }
    ).content.find((item) => item.type === "text")?.text;
    const parsed = JSON.parse(text ?? "{}");
    assert.deepEqual(calls, ["complete", "deploy"]);
    assert.equal(parsed.upload.status, "UPLOADED");
    assert.equal(parsed.deployment.id, "dep-1");
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
});

test("hosted registry exposes only product tools advertised by the workspace", async () => {
  const enabledProductTools = enabledProductToolsFrom({
    products: [
      {
        capabilities: [
          {
            family: "data",
            mcpTools: ["data_overview", "data_sources", "data_sql", "data_ask"],
          },
          {
            family: "data",
            mcpTools: ["data_insights"],
          },
        ],
      },
    ],
  });
  const tools = await listToolNames({
    localFilesystemAccess: false,
    enabledProductTools,
  });

  assert.equal(tools.includes("data_products"), true);
  assert.equal(tools.includes("data_connections"), true);
  assert.equal(tools.includes("data_ask"), true);
  assert.equal(tools.includes("data_sql"), true);
  assert.equal(tools.includes("data_insights"), true);
  assert.equal(tools.includes("data_table"), false);
  assert.equal(tools.some((name) => name.startsWith("lake_")), false);
});

test("data tools instruct agents to query with the advertised source key", async () => {
  const tools = await listToolDefinitions({
    localFilesystemAccess: false,
    enabledProductTools: new Set(["data_sources", "data_sql"]),
  });
  const dataSources = tools.find((tool) => tool.name === "data_sources");
  const dataSql = tools.find((tool) => tool.name === "data_sql");

  assert.match(dataSources?.description ?? "", /key field/i);
  assert.match(dataSql?.description ?? "", /key field/i);
  assert.match(
    String(
      (
        dataSql?.inputSchema.properties as
          | Record<string, { description?: string }>
          | undefined
      )?.sql?.description ?? "",
    ),
    /key field/i,
  );
});

test("MCP instructions make provider freshness authoritative", async () => {
  const instructions = await getServerInstructions({
    localFilesystemAccess: false,
    enabledProductTools: new Set([
      "data_ask",
      "data_table",
      "data_sources",
      "data_sql",
    ]),
  });
  const tools = await listToolDefinitions({
    localFilesystemAccess: false,
    enabledProductTools: new Set([
      "data_ask",
      "data_table",
      "data_sources",
      "data_sql",
    ]),
  });
  const description = (name: string) =>
    tools.find((tool) => tool.name === name)?.description ?? "";

  assert.match(instructions, /data_sources\.lastSyncAt is authoritative/i);
  assert.match(instructions, /row createdAt or updatedAt/i);
  assert.match(instructions, /report freshness as unknown/i);
  assert.match(instructions, /expected cadence/i);
  assert.match(description("data_sources"), /lastSyncAt is authoritative/i);
  assert.match(description("data_sources"), /freshness as unknown/i);
  assert.match(description("data_sql"), /do not infer sync freshness/i);
  assert.match(description("data_table"), /not evidence of sync freshness/i);
  assert.match(description("data_ask"), /use data_sources instead/i);
});

test("MCP instructions require evidence-based readiness before deployment", async () => {
  const instructions = await getServerInstructions({
    localFilesystemAccess: false,
  });

  assert.match(
    instructions,
    /review, prepare, validate, or fix an app for deployment does not authorize a deployment/i,
  );
  assert.match(instructions, /exact source revision or artifact/i);
  assert.match(instructions, /deployment root and build context/i);
  assert.match(instructions, /typecheck, lint, tests, production build/i);
  assert.match(instructions, /build-time variables from runtime variables/i);
  assert.match(instructions, /literal output of failed checks/i);
  assert.match(instructions, /READY, WARN, or BLOCKED/i);
  assert.match(instructions, /Never deploy a BLOCKED result/i);
  assert.match(instructions, /do not claim READY/i);
});

test("hosted registry fails closed when no product tools are advertised", async () => {
  const tools = await listToolNames({
    localFilesystemAccess: false,
    enabledProductTools: new Set(),
  });

  assert.equal(tools.includes("data_products"), true);
  assert.equal(tools.includes("data_ask"), false);
  assert.equal(tools.includes("data_insights"), false);
  assert.equal(tools.some((name) => name.startsWith("lake_")), false);
});

test("capabilities probes only families advertised by the active product", async () => {
  let lakeProbeCount = 0;
  const result = await callCapabilities(
    {
      resolveWorkspace: async () => ({
        workspaceId: "ws-creator",
        workspaceName: "Workspace",
        scopes: ["data-sources:read"],
      }),
      dataProducts: async () => ({
        products: [
          {
            capabilities: [
              {
                key: "business-data",
                family: "data",
                mcpTools: [
                  "data_overview",
                  "data_sources",
                  "data_sql",
                  "data_ask",
                ],
              },
            ],
          },
        ],
      }),
      dataSources: async () => [{ key: "deal_current" }],
      dataConnections: async () => [{ id: "source-1" }],
      lakeSourcesSummary: async () => {
        lakeProbeCount += 1;
        throw new Error("lake should not be probed");
      },
    },
    true,
  );

  assert.equal(lakeProbeCount, 0);
  assert.deepEqual(
    result.probes.map((probe) => probe.name).sort(),
    ["data_connections", "data_sources"],
  );
  assert.deepEqual(
    result.toolFamilies.find((family) => family.family === "data")?.tools,
    ["data_ask", "data_sources", "data_overview", "data_sql"],
  );
  assert.equal(
    result.toolFamilies.find((family) => family.family === "lake")
      ?.availability,
    "unavailable",
  );
});

test("capabilities skips probes by default", async () => {
  let probeCalls = 0;
  const result = await callCapabilities({
    resolveWorkspace: async () => ({
      workspaceId: "ws-1",
      workspaceName: "Workspace",
      scopes: ["data-sources:read"],
    }),
    dataProducts: async () => ({ products: [] }),
    dataConnections: async () => {
      probeCalls += 1;
      return [];
    },
  });

  assert.equal(probeCalls, 0);
  assert.deepEqual(result.probes, []);
});

test("capabilities probes expose only compact counts, status and freshness", async () => {
  const result = await callCapabilities(
    {
      resolveWorkspace: async () => ({
        workspaceId: "ws-fleet",
        workspaceName: "Workspace",
        scopes: ["data-sources:read"],
      }),
      dataProducts: async () => ({
        products: [
          {
            capabilities: [
              {
                key: "business-data",
                family: "data",
                mcpTools: ["data_sources", "lake_sources"],
              },
            ],
          },
        ],
      }),
      dataConnections: async () => [
        {
          id: "source-1",
          status: "CONNECTED",
          config: { secretMetadata: "must-not-leak" },
          lastTestedAt: "2026-07-22T13:00:00.000Z",
          updatedAt: "2026-07-22T12:00:00.000Z",
        },
      ],
      dataSources: async () => [
        {
          key: "omie",
          status: "connected",
          recordCount: 42,
          lastSyncAt: "2026-07-22T11:00:00.000Z",
          updatedAt: "2026-07-22T14:00:00.000Z",
          meta: { privateDetail: "must-not-leak" },
        },
        {
          key: "source-without-authoritative-freshness",
          status: "connected",
          updatedAt: "2026-07-22T15:00:00.000Z",
        },
      ],
      lakeSourcesSummary: async () => ({
        layers: [{ key: "gold" }],
        totals: {
          clients: 20,
          vehicleFiles: 1500,
          otherTables: 15025,
          geofenceTables: 5360,
        },
        freshness: {
          goldMaxDay: "2026-06-24",
          lagDays: 28,
          observedAt: "2026-07-22T12:00:00.000Z",
        },
        clients: [{ id: "private-client", name: "must-not-leak" }],
      }),
    },
    true,
  );

  const serialized = JSON.stringify(result.probes);
  assert.equal(serialized.includes("must-not-leak"), false);
  assert.equal(serialized.includes("private-client"), false);
  assert.deepEqual(
    result.probes.map((probe) => probe.name).sort(),
    ["data_connections", "data_sources", "lake_sources"],
  );
  assert.deepEqual(
    result.probes.find((probe) => probe.name === "data_connections")?.data,
    {
      count: 1,
      statuses: { CONNECTED: 1 },
      totalRecords: null,
      freshness: { latest: null, oldest: null },
    },
  );
  assert.deepEqual(
    result.probes.find((probe) => probe.name === "data_sources")?.data,
    {
      count: 2,
      statuses: { connected: 2 },
      totalRecords: 42,
      freshness: {
        latest: "2026-07-22T11:00:00.000Z",
        oldest: "2026-07-22T11:00:00.000Z",
      },
    },
  );
  assert.ok(serialized.length < 2_000);
});

test("lake_sources is bounded by default and supports the compact summary", async () => {
  let received:
    | { page: number; limit: number; tableLimit: number; search?: string }
    | undefined;
  let summaryCalls = 0;
  const api = {
    lakeSources: async (params: {
      page: number;
      limit: number;
      tableLimit: number;
      search?: string;
    }) => {
      received = params;
      return { layers: [], clients: [], meta: params };
    },
    lakeSourcesSummary: async () => {
      summaryCalls += 1;
      return {
        layers: [],
        totals: {
          clients: 20,
          vehicleFiles: 1500,
          otherTables: 15025,
          geofenceTables: 5360,
        },
        freshness: { goldMaxDay: "2026-06-24", lagDays: 28 },
        clients: [],
      };
    },
  } as Partial<DooorApiClient>;
  const server = createServer(api as DooorApiClient, {
    enabledProductTools: new Set(["lake_sources"]),
  });
  const client = new Client(
    { name: "dooor-mcp-lake-sources-test", version: "1.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.callTool({ name: "lake_sources", arguments: {} });
    assert.deepEqual(received, {
      page: 1,
      limit: 10,
      tableLimit: 50,
      search: undefined,
    });

    await client.callTool({
      name: "lake_sources",
      arguments: { summary: true },
    });
    assert.equal(summaryCalls, 1);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
});
