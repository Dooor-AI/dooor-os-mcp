#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DooorApiClient } from "./api-client.js";
import { createServer } from "./server.js";

const DOOOR_API_KEY = process.env.DOOOR_API_KEY;
const DOOOR_BASE_URL = process.env.DOOOR_BASE_URL || "https://os-develop.dooor.ai/api/v1";

if (!DOOOR_API_KEY) {
  console.error("Missing DOOOR_API_KEY environment variable");
  process.exit(1);
}

const api = new DooorApiClient(DOOOR_BASE_URL, DOOOR_API_KEY);
await api.resolveWorkspace();

const server = createServer(api);
const transport = new StdioServerTransport();

await server.connect(transport);
