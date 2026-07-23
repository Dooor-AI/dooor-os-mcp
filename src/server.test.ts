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
          updatedAt: "2026-07-22T12:00:00.000Z",
        },
      ],
      dataSources: async () => [
        {
          key: "omie",
          status: "connected",
          recordCount: 42,
          lastSyncAt: "2026-07-22T11:00:00.000Z",
          meta: { privateDetail: "must-not-leak" },
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
