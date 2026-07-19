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

async function listToolNames(options?: CreateServerOptions): Promise<string[]> {
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
    return response.tools.map((tool) => tool.name);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

async function callCapabilities(api: Partial<DooorApiClient>) {
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
      arguments: { includeProbes: true },
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
      probes: Array<{ name: string; ok: boolean }>;
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
  const result = await callCapabilities({
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
    lakeSources: async () => {
      lakeProbeCount += 1;
      throw new Error("lake should not be probed");
    },
  });

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
