import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { DooorApiClient } from "./api-client.js";
import { createServer, type CreateServerOptions } from "./server.js";

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
