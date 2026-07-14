import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { DooorApiClient } from "./api-client.js";
import { buildSourceTarball, MAX_TARBALL_BYTES } from "./archiver.js";
import { API_KEY_SCOPES, MCP_DEPLOY_AUTOMATION_SCOPES } from "./scopes.js";

/** Helper: wrap API calls and return formatted JSON */
async function call<T>(fn: () => Promise<T>): Promise<string> {
  try {
    const result = await fn();
    return JSON.stringify(result, null, 2);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: msg });
  }
}

const TOOL_FAMILIES = [
  {
    family: "platform",
    tools: [
      "list_apps",
      "deploy_app",
      "list_deployments",
      "list_databases",
      "query_database",
      "list_agents",
      "list_alerts",
      "get_workspace_overview",
    ],
    useFor: "Operate workspace apps, deploys, databases, agents, monitoring and git integrations.",
    readOnly: false,
  },
  {
    family: "data",
    tools: [
      "data_products",
      "data_ask",
      "data_sources",
      "data_overview",
      "data_table",
      "data_insights",
      "data_sql",
    ],
    useFor:
      "Answer business questions over connected operational sources such as field service, finance, issues and client records.",
    readOnly: true,
  },
  {
    family: "live_data_connections",
    tools: [
      "data_connections",
      "data_connection_capabilities",
      "data_connection_read",
    ],
    useFor:
      "Discover and read allowlisted entities directly from connected operational systems through the Dooor read-only proxy.",
    readOnly: true,
  },
  {
    family: "lake",
    tools: ["lake_ask", "lake_sources", "lake_catalog", "lake_query", "lake_browse", "lake_sql"],
    useFor:
      "Explore and analyze telemetry or high-volume analytical lake data through curated tools or read-only SQL.",
    readOnly: true,
  },
  {
    family: "lake_code",
    tools: ["lake_code_search", "lake_code_list"],
    useFor: "Search or page through indexed legacy business-rule source code.",
    readOnly: true,
  },
] as const;

async function probe<T>(name: string, fn: () => Promise<T>) {
  try {
    return { name, ok: true, data: await fn() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, ok: false, error: message };
  }
}

/**
 * Build a fresh MCP server bound to a given API client.
 *
 * This is the single source of truth for the tool registry: both the stdio
 * entrypoint (src/index.ts) and the HTTP entrypoint (src/http.ts) call this
 * factory. In stdio mode one client is constructed from DOOOR_API_KEY; in
 * stateless HTTP mode a fresh client (and therefore a fresh server) is built
 * per request from the request's own Authorization key, so per-client data
 * isolation holds.
 */
export function createServer(api: DooorApiClient): McpServer {
  const server = new McpServer(
    {
      name: "dooor-os",
      version: "0.1.0",
    },
    {
      instructions:
        "Dooor OS workspace access through MCP. Start with capabilities when a client needs to know " +
        "which workspace, scopes, tool families and connected data sources are available.\n\n" +
        "Tool families:\n" +
        "* platform tools: apps, deploys, git, databases, env vars, agents and monitoring. Some mutate state.\n" +
        "* data_products: discover which productized data experiences are enabled in this workspace.\n" +
        "* data_* tools: read-only business data from connected operational sources. Use data_ask for " +
        "natural-language questions such as \"quais os técnicos da base do app de campo\", " +
        "\"clientes com mais medição virtual\", \"quantas intervenções por modelo/marca\", " +
        "\"total a receber no ERP\", \"incidentes no tracker\" and \"recusas por cliente\".\n" +
        "* data_sql: read-only PostgreSQL over the curated business relations for custom joins and metrics.\n" +
        "* data_connections: list live operational connections. Then call data_connection_capabilities with " +
        "a source ID before data_connection_read. The live proxy exposes only allowlisted list/get operations, " +
        "keeps configured source filters authoritative and never returns credentials. The REST operation response " +
        "is an envelope whose data array is `records`, with rowCount, truncated, nextCursor, columns, queryId and durationMs. " +
        "Read `response.records`; never assume a top-level array or `items`/`data`/`results`.\n" +
        "  Omie finance: choose the entity that represents the requested business value. " +
        "movimento_financeiro provides actual settlements: use data_pagamento as the cash date, join " +
        "codigo_titulo to the title's codigo_lancamento_omie, and interpret natureza R as receivable and P as payable. " +
        "conta_corrente lists the registered accounts. extrato_conta_corrente provides the account statement and " +
        "ready-made current, forecast, reconciled, provisional and available balances; filter it with nCodCC, " +
        "dPeriodoInicial and dPeriodoFinal in DD/MM/YYYY. resumo_financeiro provides Omie's ready-made account " +
        "balance, payable, receivable and fluxoCaixa values. orcamento_caixa provides the monthly cash budget and " +
        "accepts nAno and nMes. Do not substitute due dates for data_pagamento or derive a bank position from titles " +
        "when a ready-made statement or financial summary answers the question.\n" +
        "* lake_* tools: read-only analytical lake and telemetry exploration. Use lake_sources and lake_catalog " +
        "to discover valid clients, layers, measures and dimensions before browsing or querying.\n" +
        "* lake_sql: read-only ClickHouse SQL for custom lake analysis when structured lake_query is too narrow.\n" +
        "* lake_code_* tools: read-only search and browsing over indexed legacy business-rule source code.\n\n" +
        "Use data_* for operational business questions, lake_* for telemetry or high-volume analytical data, " +
        "lake_code_* for implementation questions, and platform tools for managing Dooor OS resources. " +
        "All data_*, lake_* and lake_code_* tools are read-only and scoped to this workspace.\n\n" +
        "BUILDING AN APP that needs this data AT RUNTIME (not just exploring here): do NOT embed an MCP " +
        "client in the app and do NOT call the source systems directly. The app's backend calls the same " +
        "read-only REST API these tools wrap, base `DOOOR_BASE_URL` (e.g. https://api.os.dooor.ai/v1):\n" +
        "* POST /workspaces/{workspaceId}/data/sql   body {\"sql\":\"select ...\"}  (one read-only SELECT)\n" +
        "* POST /workspaces/{workspaceId}/data/ask   body {\"question\":\"...\"}    (natural-language answer)\n" +
        "* GET  /workspaces/{workspaceId}/data-products\n" +
        "* GET  /workspaces/{workspaceId}/data-sources\n" +
        "* GET  /workspaces/{workspaceId}/data-sources/{sourceId}/capabilities\n" +
        "* POST /workspaces/{workspaceId}/data-sources/{sourceId}/operation body " +
        "{\"entity\":\"...\",\"operation\":\"list|get\",\"id\":\"optional\",\"filter\":{},\"cursor\":\"optional\",\"maxRows\":100}\n" +
        "* GET  /workspaces/{workspaceId}/data/overview | /data/sources | /data/table/{key}\n" +
        "* /workspaces/{workspaceId}/data/lake/* for the analytical lake.\n" +
        "Auth with header `Authorization: Bearer <DOOOR_API_KEY>` (a dor_sk_ workspace key). Set " +
        "DOOOR_API_KEY and DOOOR_BASE_URL as server-side ENV VARS in the app, never hardcode or expose them " +
        "to browser code; resolve workspaceId once via GET /api-keys/whoami. A deployed app needs its own key " +
        "with only data-sources:read and data-sources:query, restricted to the required dataSourceIds. Never " +
        "reuse a person's MCP key. Everything is read-only and scoped to the key's workspace and source allowlist. In short: " +
        "MCP tools = dev-time exploration; the REST API = the running app. Call the integration_guide tool " +
        "for a copy-pasteable code example.",
    },
  );

  server.tool(
    "capabilities",
    "Whoami plus a compact map of this MCP server: active workspace, API key scopes, tool families, and optional read-only probes for connected data sources. Use first when you need to know what this key can access.",
    {
      includeProbes: z
        .boolean()
        .optional()
        .describe("Run lightweight read-only probes for data_sources and lake_sources. Default true."),
    },
    async ({ includeProbes = true }) => {
      const workspace = await api.resolveWorkspace();
      const probes = includeProbes
        ? await Promise.all([
            probe("data_products", () => api.dataProducts()),
            probe("data_sources", () => api.dataSources()),
            probe("data_connections", () => api.dataConnections()),
            probe("lake_sources", () => api.lakeSources()),
          ])
        : [];

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                server: "dooor-os",
                version: "0.1.0",
                workspace,
                toolFamilies: TOOL_FAMILIES,
                probes,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "integration_guide",
    "How to consume this workspace's data FROM YOUR APP'S CODE at runtime (not via MCP). Returns a copy-pasteable example: the REST endpoints, auth header, required env vars, and a TypeScript client. Call this when building an app that needs workspace data in production.",
    {},
    async () => {
      const base = api.baseUrl ?? "https://api.os.dooor.ai/v1";
      const guide = [
        "# Consuming Dooor data from your app (runtime)",
        "",
        "The MCP tools here are for DEV-TIME exploration. Your running app must NOT embed an MCP client",
        "and must NOT call the source systems directly. It calls the same read-only REST API these tools wrap.",
        "",
        "## Env vars (set in the app; never hardcode)",
        "- DOOOR_API_KEY=dor_sk_...   (a dedicated app key with only data-sources:read and data-sources:query)",
        `- DOOOR_BASE_URL=${base}`,
        "Keep both variables on the backend only. Never expose the key in browser code.",
        "",
        "## Endpoints (all read-only, workspace-scoped)",
        "- GET  {base}/workspaces/{ws}/data-products                  -> enabled data products and capabilities",
        "- POST {base}/workspaces/{ws}/data/sql   body { sql }        -> one read-only SELECT over curated relations",
        "- POST {base}/workspaces/{ws}/data/ask   body { question }   -> natural-language grounded answer",
        "- GET  {base}/workspaces/{ws}/data/overview | /data/sources | /data/table/{key}",
        "- GET  {base}/workspaces/{ws}/data-sources                    -> live connection IDs/types/status",
        "- GET  {base}/workspaces/{ws}/data-sources/{sourceId}/capabilities -> entities, list/get operations and fields",
        "- POST {base}/workspaces/{ws}/data-sources/{sourceId}/operation    -> read a live source through Dooor",
        "- {base}/workspaces/{ws}/data/lake/*      -> analytical lake (lake/sql, lake/ask, ...)",
        "- GET  {base}/api-keys/whoami            -> resolve the workspaceId from the key once at boot",
        "",
        "## Auth",
        "Header: Authorization: Bearer <DOOOR_API_KEY>",
        "",
        "## TypeScript client (drop into your backend)",
        "```ts",
        "const BASE = process.env.DOOOR_BASE_URL!;",
        "const KEY = process.env.DOOOR_API_KEY!;",
        "const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };",
        "",
        "let wsId: string | undefined;",
        "async function workspaceId() {",
        "  if (wsId) return wsId;",
        "  const r = await fetch(`${BASE}/api-keys/whoami`, { headers: H });",
        "  wsId = (await r.json()).workspaceId;",
        "  return wsId!;",
        "}",
        "",
        "export async function dooorSql(sql: string) {",
        "  const ws = await workspaceId();",
        "  const r = await fetch(`${BASE}/workspaces/${ws}/data/sql`, {",
        "    method: 'POST', headers: H, body: JSON.stringify({ sql }),",
        "  });",
        "  if (!r.ok) throw new Error(`dooor sql ${r.status}: ${await r.text()}`);",
        "  return r.json();",
        "}",
        "",
        "export async function dooorAsk(question: string) {",
        "  const ws = await workspaceId();",
        "  const r = await fetch(`${BASE}/workspaces/${ws}/data/ask`, {",
        "    method: 'POST', headers: H, body: JSON.stringify({ question }),",
        "  });",
        "  if (!r.ok) throw new Error(`dooor ask ${r.status}: ${await r.text()}`);",
        "  return r.json();",
        "}",
        "",
        "export async function dooorConnections() {",
        "  const ws = await workspaceId();",
        "  const r = await fetch(`${BASE}/workspaces/${ws}/data-sources`, { headers: H });",
        "  if (!r.ok) throw new Error(`dooor connections ${r.status}: ${await r.text()}`);",
        "  return r.json();",
        "}",
        "",
        "export async function dooorConnectionCapabilities(sourceId: string) {",
        "  const ws = await workspaceId();",
        "  const id = encodeURIComponent(sourceId);",
        "  const r = await fetch(`${BASE}/workspaces/${ws}/data-sources/${id}/capabilities`, { headers: H });",
        "  if (!r.ok) throw new Error(`dooor capabilities ${r.status}: ${await r.text()}`);",
        "  return r.json();",
        "}",
        "",
        "export async function dooorConnectionRead(sourceId: string, input: {",
        "  entity: string; operation: 'list' | 'get'; id?: string;",
        "  filter?: Record<string, unknown>; cursor?: string; maxRows?: number;",
        "}): Promise<{ records: Record<string, unknown>[]; rowCount: number; truncated: boolean; nextCursor?: string }> {",
        "  const ws = await workspaceId();",
        "  const id = encodeURIComponent(sourceId);",
        "  const r = await fetch(`${BASE}/workspaces/${ws}/data-sources/${id}/operation`, {",
        "    method: 'POST', headers: H, body: JSON.stringify(input),",
        "  });",
        "  if (!r.ok) throw new Error(`dooor connection read ${r.status}: ${await r.text()}`);",
        "  const result = await r.json();",
        "  if (!Array.isArray(result.records)) throw new Error('dooor connection read response is missing records');",
        "  return result;",
        "}",
        "```",
        "",
        "For live reads, list connections, inspect capabilities, then call only an advertised list/get operation.",
        "Configured fixed filters are enforced by Dooor and cannot be overridden by the app.",
        "## Omie finance entity selection",
        "- movimento_financeiro: actual settlements. Use data_pagamento as the cash date; join codigo_titulo to titulo_receber/titulo_pagar.codigo_lancamento_omie. natureza R is receivable and P is payable.",
        "- conta_corrente: registered bank, cash and application accounts and their Omie account codes.",
        "- extrato_conta_corrente: statement plus current, forecast, reconciled, provisional and available balances. Filter with nCodCC, dPeriodoInicial and dPeriodoFinal; dates use DD/MM/YYYY.",
        "- resumo_financeiro: Omie's ready-made account balance, accounts payable, accounts receivable and fluxoCaixa values.",
        "- orcamento_caixa: Omie's monthly cash budget. Filter with nAno and nMes.",
        "Do not substitute a title's due date for data_pagamento. Do not derive a bank position from titles when extrato_conta_corrente or resumo_financeiro answers the question directly.",
        "",
        "## Omie live-read examples",
        "```ts",
        "const settlements = await dooorConnectionRead(sourceId, {",
        "  entity: 'movimento_financeiro', operation: 'list', maxRows: 100,",
        "});",
        "const cashRows = settlements.records; // data_pagamento, valor_pago, codigo_titulo, natureza",
        "",
        "const statement = await dooorConnectionRead(sourceId, {",
        "  entity: 'extrato_conta_corrente', operation: 'list',",
        "  filter: { nCodCC: 123456789, dPeriodoInicial: '01/07/2026', dPeriodoFinal: '31/07/2026' },",
        "  maxRows: 100,",
        "});",
        "",
        "const budget = await dooorConnectionRead(sourceId, {",
        "  entity: 'orcamento_caixa', operation: 'list',",
        "  filter: { nAno: 2026, nMes: 7 },",
        "  maxRows: 100,",
        "});",
        "const budgetRows = budget.records;",
        "```",
        "Create a separate runtime key restricted to only the required dataSourceIds. Never reuse a person's MCP key.",
        "Read-only always: never attempt writes to the source systems through Dooor and never call them directly.",
        "Cache results in your own database if you need snapshots (e.g. daily).",
      ].join("\n");
      return { content: [{ type: "text" as const, text: guide }] };
    },
  );

  // ===========================================================================
  // APPS
  // ===========================================================================

  server.tool(
    "list_apps",
    "List all apps in the workspace. Optionally filter by status, type, or search term.",
    {
      status: z.string().optional().describe("Filter: active, deploying, failed, stopped, disabled"),
      search: z.string().optional().describe("Search by app name"),
      page: z.number().optional().describe("Page number (default: 1)"),
      limit: z.number().optional().describe("Items per page (default: 20, max: 100)"),
    },
    async (params) => ({
      content: [{ type: "text" as const, text: await call(() => api.listApps(params)) }],
    }),
  );

  server.tool(
    "create_app",
    "Create a new app in the workspace. Connect a Git repo and configure build settings.",
    {
      name: z.string().describe("App display name"),
      slug: z.string().describe("Unique URL slug (lowercase, hyphens allowed)"),
      description: z.string().optional().describe("App description"),
      type: z.string().optional().describe("App type: web, api, worker, cron"),
      gitRepoUrl: z.string().optional().describe("Git repository URL (e.g. github.com/org/repo)"),
      gitBranch: z.string().optional().describe("Git branch to deploy from (default: main)"),
      gitInstallationId: z.string().optional().describe("GitHub App installation ID"),
      dockerfilePath: z.string().optional().describe("Path to Dockerfile (if not using Nixpacks)"),
      autoDeploy: z.boolean().optional().describe("Auto-deploy on push (default: true)"),
    },
    async (params) => ({
      content: [{ type: "text" as const, text: await call(() => api.createApp(params)) }],
    }),
  );

  server.tool(
    "get_app",
    "Get detailed information about a specific app, including deployment status and config.",
    {
      appId: z.string().describe("App ID or slug"),
    },
    async ({ appId }) => ({
      content: [{ type: "text" as const, text: await call(() => api.getApp(appId)) }],
    }),
  );

  server.tool(
    "update_app",
    "Update an app's configuration (name, description, git branch, build settings, etc.).",
    {
      appId: z.string().describe("App ID or slug"),
      name: z.string().optional(),
      description: z.string().optional(),
      gitBranch: z.string().optional(),
      dockerfilePath: z.string().optional(),
      autoDeploy: z.boolean().optional(),
      cpuLimitMillicores: z.number().optional().describe("CPU limit in millicores (50-32000)"),
      memoryLimitMi: z.number().optional().describe("Memory limit in MiB (64-131072)"),
      minReplicas: z.number().optional(),
      maxReplicas: z.number().optional(),
    },
    async ({ appId, ...data }) => ({
      content: [{ type: "text" as const, text: await call(() => api.updateApp(appId, data)) }],
    }),
  );

  server.tool(
    "delete_app",
    "Delete an app. Use permanent=true to permanently remove all data.",
    {
      appId: z.string().describe("App ID"),
      permanent: z.boolean().optional().describe("Permanently delete (default: false, soft delete)"),
    },
    async ({ appId, permanent }) => ({
      content: [
        { type: "text" as const, text: await call(() => api.deleteApp(appId, permanent)) },
      ],
    }),
  );

  server.tool(
    "get_app_stats",
    "Get summary statistics for all apps in the workspace (total, active, failed, etc.).",
    {},
    async () => ({
      content: [{ type: "text" as const, text: await call(() => api.getAppStats()) }],
    }),
  );

  server.tool(
    "get_pipeline_state",
    "Get the full pipeline state for an app (source, build, deploy, harbor, runtime status).",
    {
      appId: z.string().describe("App ID"),
    },
    async ({ appId }) => ({
      content: [{ type: "text" as const, text: await call(() => api.getPipelineState(appId)) }],
    }),
  );

  // ===========================================================================
  // DEPLOY
  // ===========================================================================

  server.tool(
    "deploy_app",
    "Trigger a new deployment for an app using the App's currently configured source (GIT/UPLOAD/IMAGE). Optionally override the git branch or commit SHA.",
    {
      appId: z.string().describe("App ID to deploy"),
      gitBranch: z.string().optional().describe("Branch to deploy (defaults to app config)"),
      gitCommitSha: z.string().optional().describe("Specific commit SHA (defaults to latest)"),
    },
    async (params) => ({
      content: [{ type: "text" as const, text: await call(() => api.triggerDeploy(params)) }],
    }),
  );

  server.tool(
    "get_app_source",
    "Get the App source configuration (GIT repo / UPLOAD slot / IMAGE reference).",
    { appId: z.string().describe("App ID") },
    async ({ appId }) => ({
      content: [
        { type: "text" as const, text: await call(() => api.getAppSource(appId)) },
      ],
    }),
  );

  server.tool(
    "set_app_source",
    "Configure or replace the App's persistent source. Use type=GIT for git-connected apps, type=IMAGE for pre-built registry images. Type=UPLOAD only signals intent; actual tarballs ship via deploy_app_from_directory.",
    {
      appId: z.string().describe("App ID"),
      type: z.enum(["GIT", "UPLOAD", "IMAGE"]).describe("Source type"),
      gitRepoUrl: z.string().optional().describe("GIT: HTTPS clone URL"),
      gitBranch: z.string().optional().describe("GIT: default branch"),
      gitProvider: z
        .enum(["GITHUB", "GITLAB", "BITBUCKET"])
        .optional()
        .describe("GIT: provider hint"),
      gitInstallationId: z
        .string()
        .optional()
        .describe("GIT: GitInstallation id for private repos"),
      imageRef: z
        .string()
        .optional()
        .describe("IMAGE: registry reference like ghcr.io/foo/bar:v1"),
      imageRegistryAuthRef: z
        .string()
        .optional()
        .describe("IMAGE: Vault path with registry credentials (private images)"),
    },
    async ({ appId, ...data }) => ({
      content: [
        {
          type: "text" as const,
          text: await call(() => api.setAppSource(appId, data)),
        },
      ],
    }),
  );

  server.tool(
    "deploy_app_from_directory",
    "Tar a local directory (respecting .dockerignore/.gitignore + safe defaults), upload it, and trigger a deploy. Use this when the user wants to ship an app from their local filesystem without pushing to git. The MCP runs locally so it has filesystem access. Returns the new deployment id.",
    {
      appId: z.string().describe("App ID to deploy"),
      path: z
        .string()
        .describe(
          "Absolute path to the project root on the user's machine (the dir containing the Dockerfile)",
        ),
      extraExcludes: z
        .array(z.string())
        .optional()
        .describe("Extra ignore patterns to merge with .dockerignore/.gitignore"),
      triggerType: z
        .enum(["MANUAL", "WEBHOOK", "ROLLBACK", "AUTO_DEPLOY", "ENV_CHANGE"])
        .optional(),
    },
    async ({ appId, path, extraExcludes, triggerType }) => {
      return {
        content: [
          {
            type: "text" as const,
            text: await call(async () => {
              const tar = await buildSourceTarball(path, extraExcludes);
              const init = await api.initUpload(appId, {
                sizeBytes: tar.sizeBytes,
                sha256: tar.sha256,
              });
              await api.putToPresignedUrl(
                init.presignedPutUrl,
                init.headers,
                tar.data,
              );
              await api.completeUpload(appId, init.uploadId, {
                sha256: tar.sha256,
              });
              const deployment = await api.triggerDeploy({
                appId,
                triggerType,
                source: { type: "UPLOAD", uploadId: init.uploadId },
              } as any);
              return {
                uploadId: init.uploadId,
                tarballBytes: tar.sizeBytes,
                tarballSha256: tar.sha256,
                excludedEnvFiles: tar.excludedEnvFiles,
                deployment,
              };
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "deploy_app_from_tarball",
    "Upload an already-built .tar.gz file and trigger a deploy. Use when the user has a prepared tarball; otherwise prefer deploy_app_from_directory which handles tar creation.",
    {
      appId: z.string().describe("App ID to deploy"),
      tarballPath: z.string().describe("Absolute path to .tar.gz on the user's machine"),
      triggerType: z
        .enum(["MANUAL", "WEBHOOK", "ROLLBACK", "AUTO_DEPLOY", "ENV_CHANGE"])
        .optional(),
    },
    async ({ appId, tarballPath, triggerType }) => {
      return {
        content: [
          {
            type: "text" as const,
            text: await call(async () => {
              const stat = statSync(tarballPath);
              if (stat.size > MAX_TARBALL_BYTES) {
                throw new Error(
                  `Tarball is ${stat.size} bytes, exceeds limit of ${MAX_TARBALL_BYTES}`,
                );
              }
              const data = readFileSync(tarballPath);
              const sha256 = createHash("sha256").update(data).digest("hex");
              const init = await api.initUpload(appId, {
                sizeBytes: data.length,
                sha256,
              });
              await api.putToPresignedUrl(
                init.presignedPutUrl,
                init.headers,
                data,
              );
              await api.completeUpload(appId, init.uploadId, { sha256 });
              const deployment = await api.triggerDeploy({
                appId,
                triggerType,
                source: { type: "UPLOAD", uploadId: init.uploadId },
              } as any);
              return {
                uploadId: init.uploadId,
                tarballBytes: data.length,
                tarballSha256: sha256,
                deployment,
              };
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "deploy_app_from_image",
    "Trigger a deploy from a pre-built container image (no build step). Use when the user already published an image to a registry. The image must be pullable by the cluster; for private registries pass registryAuthRef pointing to credentials in Vault.",
    {
      appId: z.string().describe("App ID to deploy"),
      imageRef: z
        .string()
        .describe("Image reference, e.g. ghcr.io/org/repo:v1.2.3 or docker.io/library/nginx:alpine"),
      registryAuthRef: z
        .string()
        .optional()
        .describe("Vault path holding registry credentials for private images"),
      triggerType: z
        .enum(["MANUAL", "WEBHOOK", "ROLLBACK", "AUTO_DEPLOY", "ENV_CHANGE"])
        .optional(),
    },
    async ({ appId, imageRef, registryAuthRef, triggerType }) => ({
      content: [
        {
          type: "text" as const,
          text: await call(() =>
            api.triggerDeploy({
              appId,
              triggerType,
              source: { type: "IMAGE", imageRef, registryAuthRef },
            } as any),
          ),
        },
      ],
    }),
  );

  server.tool(
    "list_deployments",
    "List deployment history for an app.",
    {
      appId: z.string().describe("App ID"),
      status: z.string().optional().describe("Filter by status"),
      page: z.number().optional(),
      limit: z.number().optional(),
    },
    async ({ appId, ...params }) => ({
      content: [
        { type: "text" as const, text: await call(() => api.listDeployments(appId, params)) },
      ],
    }),
  );

  server.tool(
    "get_deployment",
    "Get details of a specific deployment.",
    {
      deployId: z.string().describe("Deployment ID"),
    },
    async ({ deployId }) => ({
      content: [{ type: "text" as const, text: await call(() => api.getDeployment(deployId)) }],
    }),
  );

  server.tool(
    "get_runtime_status",
    "Get live Kubernetes runtime status for a deployment (pods, phase, conditions).",
    {
      deployId: z.string().describe("Deployment ID"),
    },
    async ({ deployId }) => ({
      content: [
        { type: "text" as const, text: await call(() => api.getRuntimeStatus(deployId)) },
      ],
    }),
  );

  server.tool(
    "get_build_logs",
    "Get build logs for a deployment. Useful for debugging failed builds.",
    {
      deployId: z.string().describe("Deployment ID"),
    },
    async ({ deployId }) => ({
      content: [{ type: "text" as const, text: await call(() => api.getBuildLogs(deployId)) }],
    }),
  );

  server.tool(
    "scale_app",
    "Scale an app to a specific number of replicas. Use replicas=0 to stop the app.",
    {
      appId: z.string().describe("App ID"),
      replicas: z.number().describe("Number of replicas (0=stop, 1-10)"),
    },
    async ({ appId, replicas }) => ({
      content: [{ type: "text" as const, text: await call(() => api.scaleApp(appId, replicas)) }],
    }),
  );

  server.tool(
    "rollback_deploy",
    "Rollback to a specific deployment. Creates a new deployment from the specified version.",
    {
      deployId: z.string().describe("Deployment ID to rollback to"),
    },
    async ({ deployId }) => ({
      content: [{ type: "text" as const, text: await call(() => api.rollback(deployId)) }],
    }),
  );

  server.tool(
    "list_revisions",
    "List all revisions for an app with current traffic allocation percentages.",
    {
      appId: z.string().describe("App ID"),
    },
    async ({ appId }) => ({
      content: [{ type: "text" as const, text: await call(() => api.listRevisions(appId)) }],
    }),
  );

  server.tool(
    "set_traffic",
    "Set traffic allocation across revisions. Percentages must sum to 100. Cloud Run supports weighted splits; the current K8s runtime only supports a single 100% active revision.",
    {
      appId: z.string().describe("App ID"),
      splits: z
        .array(
          z.object({
            revisionId: z.string(),
            percent: z.number().describe("Traffic percentage (0-100)"),
            tag: z.string().optional(),
          }),
        )
        .describe("Traffic split configuration"),
    },
    async ({ appId, splits }) => ({
      content: [{ type: "text" as const, text: await call(() => api.setTraffic(appId, splits)) }],
    }),
  );

  // ===========================================================================
  // GIT
  // ===========================================================================

  server.tool(
    "get_git_install_url",
    "Get the GitHub App installation URL. Redirect users here to connect their GitHub org.",
    {},
    async () => ({
      content: [{ type: "text" as const, text: await call(() => api.getGitInstallUrl()) }],
    }),
  );

  server.tool(
    "list_git_installations",
    "List connected GitHub installations for the workspace.",
    {
      page: z.number().optional(),
      limit: z.number().optional(),
    },
    async (params) => ({
      content: [
        { type: "text" as const, text: await call(() => api.listGitInstallations(params)) },
      ],
    }),
  );

  server.tool(
    "list_repos",
    "List repositories available from a GitHub installation.",
    {
      installationId: z.string().describe("GitHub installation ID"),
      page: z.number().optional(),
      limit: z.number().optional(),
    },
    async ({ installationId, ...params }) => ({
      content: [
        { type: "text" as const, text: await call(() => api.listRepos(installationId, params)) },
      ],
    }),
  );

  server.tool(
    "list_branches",
    "List branches for a specific repository.",
    {
      owner: z.string().describe("Repository owner"),
      repo: z.string().describe("Repository name"),
      installationId: z.string().describe("GitHub installation ID"),
    },
    async ({ owner, repo, installationId }) => ({
      content: [
        {
          type: "text" as const,
          text: await call(() => api.listBranches(owner, repo, installationId)),
        },
      ],
    }),
  );

  // ===========================================================================
  // ENV VARS
  // ===========================================================================

  server.tool(
    "list_env_vars",
    "List all environment variables for an app. Secret values are masked.",
    {
      appId: z.string().describe("App ID"),
    },
    async ({ appId }) => ({
      content: [{ type: "text" as const, text: await call(() => api.listEnvVars(appId)) }],
    }),
  );

  server.tool(
    "set_env_vars",
    "Bulk set environment variables for an app. Existing keys are updated, new keys are created.",
    {
      appId: z.string().describe("App ID"),
      vars: z
        .array(
          z.object({
            key: z.string().describe("Variable name (e.g. DATABASE_URL)"),
            value: z.string().describe("Variable value"),
            isSecret: z.boolean().optional().describe("Mark as secret (masked in UI)"),
          }),
        )
        .describe("Environment variables to set"),
    },
    async ({ appId, vars }) => ({
      content: [{ type: "text" as const, text: await call(() => api.bulkSetEnvVars(appId, vars)) }],
    }),
  );

  server.tool(
    "sync_env_vars",
    "Sync environment variables to the running containers without a full redeploy.",
    {
      appId: z.string().describe("App ID"),
    },
    async ({ appId }) => ({
      content: [{ type: "text" as const, text: await call(() => api.syncEnvVars(appId)) }],
    }),
  );

  server.tool(
    "delete_env_var",
    "Delete an environment variable from an app.",
    {
      appId: z.string().describe("App ID"),
      envVarId: z.string().describe("Environment variable ID"),
    },
    async ({ appId, envVarId }) => ({
      content: [
        { type: "text" as const, text: await call(() => api.deleteEnvVar(appId, envVarId)) },
      ],
    }),
  );

  // ===========================================================================
  // DATABASES
  // ===========================================================================

  server.tool(
    "list_databases",
    "List managed databases in the workspace.",
    {
      engine: z.string().optional().describe("Filter: postgresql, mysql, redis"),
      search: z.string().optional().describe("Search by name"),
    },
    async (params) => ({
      content: [{ type: "text" as const, text: await call(() => api.listDatabases(params)) }],
    }),
  );

  server.tool(
    "create_database",
    "Provision a new managed database. POSTGRES = full Cloud Native PG cluster (separate Pod, network-accessible). SQLITE = file-based, mounted into the app pod via PVC (single-writer, RWO; the consuming app must be pinned to maxReplicas=1). REDIS = key-value store via StatefulSet. For demos and single-pod apps without scale-out needs, prefer SQLITE because it provisions instantly without Longhorn HA pressure.",
    {
      name: z.string().describe("Database display name"),
      slug: z.string().describe("Unique slug (DNS-1123 format, e.g. my-db)"),
      engine: z
        .enum(["POSTGRES", "REDIS", "SQLITE"])
        .describe("Database engine: POSTGRES, REDIS, or SQLITE"),
      version: z.string().optional().describe("Engine version"),
      cpu: z.string().optional().describe("CPU allocation (e.g. 250m, 1). Ignored for SQLITE."),
      memory: z.string().optional().describe("Memory allocation (e.g. 512Mi, 1Gi). Ignored for SQLITE."),
      storageGb: z
        .number()
        .optional()
        .describe("Storage in GB (1-1024). Defaults: Postgres/Redis 10Gi, SQLite 1Gi."),
      storageClass: z
        .string()
        .optional()
        .describe(
          "K8s StorageClass for the PVC. Defaults to the cluster default. Override only when you need to bypass Longhorn (e.g. local-path on a small cluster).",
        ),
      highAvailability: z
        .boolean()
        .optional()
        .describe(
          "POSTGRES only: provisions 2 instances with hard anti-affinity. Requires ≥3 schedulable workers. Defaults to false to keep first-time provisioning predictable on small clusters.",
        ),
      projectId: z.string().optional().describe("Project to scope the database under."),
    },
    async (params) => ({
      content: [{ type: "text" as const, text: await call(() => api.createDatabase(params)) }],
    }),
  );

  server.tool(
    "attach_database",
    "Attach a managed database to an app. SQLITE: mounts the PVC at the given path (default /var/lib/dooor/sqlite) and injects DATABASE_URL=file:<path>/db.sqlite via envFrom Secret on the next deploy; the app is pinned to maxReplicas=1. POSTGRES/REDIS: records the link; auto-injection of the connection string into env is on the roadmap.",
    {
      dbId: z.string().describe("Database ID"),
      appId: z.string().describe("App that should consume the database"),
      mountPath: z
        .string()
        .optional()
        .describe(
          "SQLITE only: absolute path inside the app pod where the PVC is mounted. Defaults to /var/lib/dooor/sqlite.",
        ),
    },
    async ({ dbId, appId, mountPath }) => ({
      content: [
        {
          type: "text" as const,
          text: await call(() =>
            api.attachDatabase(dbId, { appId, ...(mountPath ? { mountPath } : {}) }),
          ),
        },
      ],
    }),
  );

  server.tool(
    "detach_database",
    "Detach a database from an app. The database itself stays provisioned and its data is preserved; only the link is removed. The next deploy will not mount the volume or inject the connection Secret.",
    {
      dbId: z.string().describe("Database ID"),
      appId: z.string().describe("App to detach"),
    },
    async ({ dbId, appId }) => ({
      content: [
        { type: "text" as const, text: await call(() => api.detachDatabase(dbId, appId)) },
      ],
    }),
  );

  server.tool(
    "list_app_databases",
    "List databases attached to an app, including the mount path (for SQLite) and the connection Secret name.",
    {
      appId: z.string().describe("App ID"),
    },
    async ({ appId }) => ({
      content: [{ type: "text" as const, text: await call(() => api.listAppDatabases(appId)) }],
    }),
  );

  server.tool(
    "get_database",
    "Get details of a managed database.",
    {
      dbId: z.string().describe("Database ID"),
    },
    async ({ dbId }) => ({
      content: [{ type: "text" as const, text: await call(() => api.getDatabase(dbId)) }],
    }),
  );

  server.tool(
    "get_database_status",
    "Get runtime status of a database (ready/desired pods).",
    {
      dbId: z.string().describe("Database ID"),
    },
    async ({ dbId }) => ({
      content: [{ type: "text" as const, text: await call(() => api.getDatabaseStatus(dbId)) }],
    }),
  );

  server.tool(
    "get_database_connection",
    "Get connection credentials for a database (URI, username, password, host, port).",
    {
      dbId: z.string().describe("Database ID"),
    },
    async ({ dbId }) => ({
      content: [
        { type: "text" as const, text: await call(() => api.getDatabaseConnection(dbId)) },
      ],
    }),
  );

  server.tool(
    "query_database",
    "Run a read-only SQL query against a managed POSTGRES database and get the rows back. Only SELECT, WITH, SHOW, DESCRIBE and EXPLAIN are allowed; writes and DDL are rejected server-side. A LIMIT is injected when absent and results are row-capped. Every call is audited. Requires the databases:query scope and the database to be RUNNING.",
    {
      dbId: z.string().describe("Database ID (POSTGRES engine)"),
      sql: z
        .string()
        .describe("Read-only SQL. Must start with SELECT, WITH, SHOW, DESCRIBE or EXPLAIN."),
      maxRows: z
        .number()
        .int()
        .min(1)
        .max(50000)
        .optional()
        .describe("Optional row cap. The server clamps this to its configured maximum."),
    },
    async ({ dbId, sql, maxRows }) => ({
      content: [
        { type: "text" as const, text: await call(() => api.queryDatabase(dbId, sql, maxRows)) },
      ],
    }),
  );

  server.tool(
    "delete_database",
    "Permanently delete a managed database and all its data. This cannot be undone.",
    {
      dbId: z.string().describe("Database ID"),
    },
    async ({ dbId }) => ({
      content: [{ type: "text" as const, text: await call(() => api.deleteDatabase(dbId)) }],
    }),
  );

  // ===========================================================================
  // AGENTS
  // ===========================================================================

  server.tool(
    "list_agents",
    "List AI agents in the workspace.",
    {
      status: z.string().optional().describe("Filter: active, inactive, deploying, failed, stopped"),
      search: z.string().optional().describe("Search by name"),
      page: z.number().optional(),
      limit: z.number().optional(),
    },
    async (params) => ({
      content: [{ type: "text" as const, text: await call(() => api.listAgents(params)) }],
    }),
  );

  server.tool(
    "create_agent",
    "Create a new AI agent. Use a template for quick setup, or configure from scratch.",
    {
      name: z.string().describe("Agent name (1-255 characters)"),
      slug: z.string().optional().describe("Unique slug"),
      description: z.string().optional(),
      templateId: z.string().optional().describe("Template UUID to use as base"),
      soul: z.string().optional().describe("Agent personality (SOUL.md content)"),
      modelProvider: z.string().optional().describe("Model provider (e.g. GEMINI, OPENAI). Omit to use the platform default. NEVER guess or invent a provider."),
      modelName: z.string().optional().describe("Specific model name/version. Omit to use the platform default - the backend always picks the current recommended model. Do NOT guess a model name; if the user asks for a specific model, ask them to confirm the exact identifier."),
    },
    async (params) => ({
      content: [{ type: "text" as const, text: await call(() => api.createAgent(params)) }],
    }),
  );

  server.tool(
    "get_agent",
    "Get detailed information about a specific agent.",
    {
      agentId: z.string().describe("Agent ID"),
    },
    async ({ agentId }) => ({
      content: [{ type: "text" as const, text: await call(() => api.getAgent(agentId)) }],
    }),
  );

  server.tool(
    "update_agent",
    "Update an agent's configuration.",
    {
      agentId: z.string().describe("Agent ID"),
      name: z.string().optional(),
      description: z.string().optional(),
      soul: z.string().optional(),
      modelName: z.string().optional(),
    },
    async ({ agentId, ...data }) => ({
      content: [{ type: "text" as const, text: await call(() => api.updateAgent(agentId, data)) }],
    }),
  );

  server.tool(
    "deploy_agent",
    "Trigger an agent deploy. Returns immediately with a deployment record (status RECONCILING). The pod readiness check runs asynchronously - DO NOT report success or failure based on this response alone. To know whether the deploy actually succeeded, poll get_agent_deployment until status reaches READY/FAILED/TIMEOUT.",
    {
      agentId: z.string().describe("Agent ID"),
    },
    async ({ agentId }) => ({
      content: [{ type: "text" as const, text: await call(() => api.deployAgent(agentId)) }],
    }),
  );

  server.tool(
    "list_agent_deployments",
    "List recent deploy attempts for an agent (most recent first). Use to find a deploymentId to inspect or to see deploy history.",
    {
      agentId: z.string().describe("Agent ID"),
      limit: z.number().optional().describe("Max records (default 20, max 100)"),
    },
    async ({ agentId, limit }) => ({
      content: [
        {
          type: "text" as const,
          text: await call(() => api.listAgentDeployments(agentId, limit)),
        },
      ],
    }),
  );

  server.tool(
    "get_agent_deployment",
    "Get a specific agent deployment, including K8s pod events captured on failure. Use this AFTER deploy_agent to know whether the deploy actually succeeded - the response includes status (PENDING/RECONCILING/READY/FAILED/TIMEOUT), errorReason, errorMessage, and (when failed) k8sEvents with the actual pod-level cause (ImagePullBackOff, CrashLoopBackOff, etc).",
    {
      agentId: z.string().describe("Agent ID"),
      deploymentId: z.string().describe("Deployment ID returned by deploy_agent"),
    },
    async ({ agentId, deploymentId }) => ({
      content: [
        {
          type: "text" as const,
          text: await call(() => api.getAgentDeployment(agentId, deploymentId)),
        },
      ],
    }),
  );

  server.tool(
    "stop_agent",
    "Stop a running agent (scales container to 0).",
    {
      agentId: z.string().describe("Agent ID"),
    },
    async ({ agentId }) => ({
      content: [{ type: "text" as const, text: await call(() => api.stopAgent(agentId)) }],
    }),
  );

  server.tool(
    "restart_agent",
    "Trigger a rolling restart of an agent container.",
    {
      agentId: z.string().describe("Agent ID"),
    },
    async ({ agentId }) => ({
      content: [{ type: "text" as const, text: await call(() => api.restartAgent(agentId)) }],
    }),
  );

  server.tool(
    "chat_with_agent",
    "Send a message to an agent and get a response. Pass sessionId to continue a conversation.",
    {
      agentId: z.string().describe("Agent ID"),
      prompt: z.string().describe("Message to send"),
      sessionId: z.string().optional().describe("Session ID for multi-turn conversation"),
    },
    async ({ agentId, prompt, sessionId }) => ({
      content: [
        {
          type: "text" as const,
          text: await call(() => api.chatWithAgent(agentId, prompt, sessionId)),
        },
      ],
    }),
  );

  server.tool(
    "list_agent_templates",
    "List available agent templates for quick agent creation.",
    {},
    async () => ({
      content: [{ type: "text" as const, text: await call(() => api.listAgentTemplates()) }],
    }),
  );

  // ===========================================================================
  // MONITORING
  // ===========================================================================

  server.tool(
    "get_app_health",
    "Get health status of an app (healthy, degraded, unhealthy, unknown).",
    {
      appId: z.string().describe("App ID"),
    },
    async ({ appId }) => ({
      content: [{ type: "text" as const, text: await call(() => api.getAppHealth(appId)) }],
    }),
  );

  server.tool(
    "get_app_metrics",
    "Get app performance metrics (CPU, memory, requests, latency, errors).",
    {
      appId: z.string().describe("App ID"),
      period: z.string().optional().describe("Time period: 1h, 6h, 24h, 7d, 30d (default: 24h)"),
    },
    async ({ appId, period }) => ({
      content: [
        { type: "text" as const, text: await call(() => api.getAppMetrics(appId, period)) },
      ],
    }),
  );

  server.tool(
    "get_app_logs",
    "Get application logs. Useful for debugging runtime issues.",
    {
      appId: z.string().describe("App ID"),
      limit: z.number().optional().describe("Max log entries (default: 100)"),
      severity: z.string().optional().describe("Filter by severity: INFO, WARNING, ERROR"),
    },
    async ({ appId, ...params }) => ({
      content: [{ type: "text" as const, text: await call(() => api.getAppLogs(appId, params)) }],
    }),
  );

  server.tool(
    "get_workspace_overview",
    "Get a high-level overview of the workspace: total apps, deploys today, health summary, costs.",
    {},
    async () => ({
      content: [{ type: "text" as const, text: await call(() => api.getWorkspaceOverview()) }],
    }),
  );

  server.tool(
    "list_alerts",
    "List monitoring alerts for the workspace or a specific app.",
    {
      appId: z.string().optional().describe("Filter by app ID"),
      resolved: z.boolean().optional().describe("Filter by resolved status"),
      limit: z.number().optional(),
    },
    async (params) => ({
      content: [{ type: "text" as const, text: await call(() => api.listAlerts(params)) }],
    }),
  );

  // ===========================================================================
  // API KEYS
  // ===========================================================================

  server.tool(
    "list_api_keys",
    "List all API keys in the workspace (secrets are never returned).",
    {},
    async () => ({
      content: [{ type: "text" as const, text: await call(() => api.listApiKeys()) }],
    }),
  );

  server.tool(
    "create_api_key",
    "Create a new API key. Scopes are mandatory and should be kept minimal. The secret is returned only once.",
    {
      name: z.string().describe("Key label (e.g. Production, CI/CD)"),
      scopes: z
        .array(z.enum(API_KEY_SCOPES))
        .min(1)
        .describe(
          `Granted scopes. Recommended for a deploy automation agent: ${MCP_DEPLOY_AUTOMATION_SCOPES.join(", ")}`,
        ),
      expiresAt: z.string().optional().describe("Expiration date (ISO 8601). Omit for no expiry."),
      dataSourceIds: z
        .array(z.string())
        .optional()
        .describe(
          "Optional source allowlist. For a runtime data app, pass only the connection IDs the app needs.",
        ),
    },
    async ({ name, scopes, expiresAt, dataSourceIds }) => ({
      content: [
        {
          type: "text" as const,
          text: await call(() =>
            api.createApiKey(name, scopes, expiresAt, dataSourceIds),
          ),
        },
      ],
    }),
  );

  server.tool(
    "revoke_api_key",
    "Permanently revoke an API key. Cannot be undone.",
    {
      keyId: z.string().describe("API key ID"),
    },
    async ({ keyId }) => ({
      content: [{ type: "text" as const, text: await call(() => api.revokeApiKey(keyId)) }],
    }),
  );

  // ===========================================================================
  // Workspace data products and connected workspace data over MCP
  // ===========================================================================

  server.tool(
    "data_connections",
    "List the live operational data connections visible to this key. Returns neutral connection IDs, names, types and status without credentials. Use the selected sourceId with data_connection_capabilities before reading it.",
    {},
    async () => ({
      content: [
        {
          type: "text" as const,
          text: await call(() => api.dataConnections()),
        },
      ],
    }),
  );

  server.tool(
    "data_connection_capabilities",
    "Discover the allowlisted read-only entities, list/get operations, typed fields, pagination contract and fixed filter keys for one live connection. Fixed filters are enforced by Dooor and cannot be overridden by the caller.",
    {
      sourceId: z.string().describe("Connection ID returned by data_connections"),
    },
    async ({ sourceId }) => ({
      content: [
        {
          type: "text" as const,
          text: await call(() => api.dataConnectionCapabilities(sourceId)),
        },
      ],
    }),
  );

  server.tool(
    "data_connection_read",
    "Execute one allowlisted read-only list/get operation through Dooor. Call data_connection_capabilities first and use exactly one entity and operation it returns. The REST equivalent returns an envelope whose row array is `records`, plus rowCount, truncated, nextCursor, columns, queryId and durationMs. Runtime apps must read response.records, not a top-level array or items/data/results. This tool never exposes source credentials and never performs source writes.",
    {
      sourceId: z.string().describe("Connection ID returned by data_connections"),
      entity: z
        .string()
        .describe("Entity key returned by data_connection_capabilities"),
      operation: z.enum(["list", "get"]),
      id: z
        .string()
        .optional()
        .describe("Record identifier, required when the selected get operation needs one"),
      filter: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Optional provider-neutral read filter. Server-side fixed filters always win."),
      cursor: z.string().optional().describe("Opaque nextCursor from the previous response"),
      maxRows: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Maximum rows for this response, subject to the server cap"),
    },
    async ({ sourceId, ...params }) => ({
      content: [
        {
          type: "text" as const,
          text: await call(() => api.dataConnectionRead(sourceId, params)),
        },
      ],
    }),
  );

  server.tool(
    "data_products",
    "List the productized data experiences enabled in this workspace, including capabilities, REST paths, MCP tools and backing stores. Use this before choosing data_* or lake_* tools for a new workspace.",
    {},
    async () => ({
      content: [{ type: "text" as const, text: await call(() => api.dataProducts()) }],
    }),
  );

  server.tool(
    "data_overview",
    "Get the aggregated workspace data overview: ERP financials (a receber/pagar, recebido, inadimplencia, fluxo mensal, top clientes/categorias), issue-tracker demands (by status/type/project), client base, and field-service DB schema.",
    {},
    async () => ({
      content: [{ type: "text" as const, text: await call(() => api.dataOverview()) }],
    }),
  );

  server.tool(
    "data_ask",
    "PRIMARY data tool. Ask any natural-language business question (PT-BR or EN) about the workspace's own data and get a grounded answer. Use this for questions about: o APP DE CAMPO / intervencoes de campo (TECNICOS/instaladores, veiculo marca/modelo, MEDICAO virtual vs fisica - RPM/horimetro/odometro, recusas, precos, vinculos de ticket), o financeiro do ERP (a receber/pagar, recebido, inadimplencia), as DEMANDAS do issue tracker (incidentes/status), e a base de CLIENTES. Ex.: 'quais os tecnicos da base do app de campo?', 'clientes com maior % de medicao virtual', 'intervencoes por modelo de equipamento', 'total a receber em aberto'. An orchestrator cross-references the sources deterministically and returns the answer + the per-source steps + a data table. Read-only.",
    {
      question: z.string().describe("Business question in natural language (PT-BR or EN)"),
    },
    async ({ question }) => ({
      content: [{ type: "text" as const, text: await call(() => api.dataAsk(question)) }],
    }),
  );

  server.tool(
    "data_table",
    "Preview rows from one connected source. key = 'omie' (financial titles) | 'jira' (issues) | 'clientes' | 'installer' (field interventions: technician, vehicle brand/model, measurement flags, prices, ticket links).",
    {
      key: z.enum(["omie", "jira", "clientes", "installer"]).describe("Which source to preview"),
      limit: z.number().optional().describe("Max rows (default 25, max 100)"),
    },
    async ({ key, limit }) => ({
      content: [{ type: "text" as const, text: await call(() => api.dataTable(key, limit)) }],
    }),
  );

  server.tool(
    "data_sources",
    "List the data sources connected for this workspace, each with its live record count and stats (ERP financeiro, issue-tracker demandas, base de clientes, app de campo). Use this to see what data is available before asking.",
    {},
    async () => ({
      content: [{ type: "text" as const, text: await call(() => api.dataSources()) }],
    }),
  );

  server.tool(
    "data_insights",
    "Get the latest proactive insight digest discovered across the connected sources (ranked findings with metric, value, evidence and recommended action). Read-only.",
    {},
    async () => ({
      content: [{ type: "text" as const, text: await call(() => api.dataInsightsLatest()) }],
    }),
  );

  // ── Data lake (telemetry data lake on ClickHouse, ~billions of rows) ──

  server.tool(
    "lake_ask",
    "Ask a natural-language question (PT-BR or EN) about FLEET TELEMETRY in the data lake: vehicle utilization, idle time ('tempo ocioso' = engine on but not moving), distance, fuel, by client/vehicle/day. An agent plans a deterministic ClickHouse query grounded in the business-rule catalog, executes it over the gold marts, and returns the answer + data. Use for questions like 'qual cliente tem o maior tempo ocioso?', 'utilizacao da frota de um cliente no ultimo mes', 'consumo medio por veiculo'. Read-only.",
    {
      question: z.string().describe("Fleet-telemetry question in natural language (PT-BR or EN)"),
    },
    async ({ question }) => ({
      content: [{ type: "text" as const, text: await call(() => api.lakeAsk(question)) }],
    }),
  );

  server.tool(
    "lake_dashboard",
    "Generate an INTELLIGENT DASHBOARD about fleet telemetry from a natural-language brief. An agent picks the right metrics/dimensions from the catalog, builds a multi-panel dashboard spec (kpi/line/bar/table), executes each panel over the lake, and returns the panels with data ready to render. Use when the user wants to 'criar/montar um dashboard sobre <cliente/tema>'. Read-only.",
    {
      prompt: z.string().describe("What the dashboard should cover, e.g. 'dashboard de ociosidade e utilizacao de um cliente'"),
    },
    async ({ prompt }) => ({
      content: [{ type: "text" as const, text: await call(() => api.lakeDashboard(prompt)) }],
    }),
  );

  server.tool(
    "lake_query",
    "Run a STRUCTURED, validated aggregation over the fleet telemetry lake (no raw SQL). Provide measures + dimensions from the catalog (see lake_catalog). Every key is validated against the catalog before execution. Read-only.",
    {
      measures: z.array(z.string()).describe("Measure keys, e.g. ['utilization_pct','idle_pct','idle_hours']"),
      dimensions: z.array(z.string()).optional().describe("Dimension keys, e.g. ['client_name'] or ['vehicle_id']"),
      granularity: z.enum(["day", "week", "month"]).optional().describe("Time bucketing"),
      orderBy: z.string().optional().describe("Measure key to sort by (desc)"),
      limit: z.number().optional(),
    },
    async (spec) => ({
      content: [{ type: "text" as const, text: await call(() => api.lakeQuery(spec)) }],
    }),
  );

  server.tool(
    "lake_catalog",
    "Get the fleet-telemetry lake catalog: available clients, measures (utilization, idle, distance, fuel...), dimensions, and the business-rule glossary. Use to discover valid keys for lake_query. Read-only.",
    {},
    async () => ({
      content: [{ type: "text" as const, text: await call(() => api.lakeCatalog()) }],
    }),
  );

  server.tool(
    "lake_sources",
    "List everything the fleet data lake exposes for RAW exploration: the camadas (bronze_positions = raw GPS/CAN telemetry per vehicle, ~80 columns; bronze_other = auxiliary tables like drivers/crons; bronze_geofence = geofences; gold = vehicle_daily aggregate) and, per client (DB_MD_<n>), the real tables that exist in /data/lake. Use this to discover client ids and table names to pass to lake_browse. Read-only.",
    {},
    async () => ({
      content: [{ type: "text" as const, text: await call(() => api.lakeSources()) }],
    }),
  );

  server.tool(
    "lake_browse",
    "Read RAW rows straight off the lake: bronze layers query the Parquet via ClickHouse file(); gold queries the vehicle_daily gold mart. Returns the real columns (with types), the rows, the exact SQL that ran and the server-side query time (queryMs). Discover valid layer/client/table via lake_sources. For bronze layers pass client=DB_MD_<n>; for bronze_other/bronze_geofence also pass table; for bronze_positions optionally pass vehicleId to focus one vehicle. Read-only, max 1000 rows.",
    {
      layer: z
        .enum(["bronze_positions", "bronze_other", "bronze_geofence", "gold"])
        .describe("Camada/fonte a navegar"),
      client: z.string().optional().describe("Client id DB_MD_<n> (required for bronze layers)"),
      table: z.string().optional().describe("Table name (for bronze_other / bronze_geofence)"),
      vehicleId: z.string().optional().describe("Filter to a single vehicle (bronze_positions)"),
      limit: z.number().optional().describe("Max rows (default 50, max 1000)"),
    },
    async (p) => ({
      content: [{ type: "text" as const, text: await call(() => api.lakeBrowse(p)) }],
    }),
  );

  server.tool(
    "data_sql",
    "Run AD-HOC READ-ONLY SQL over the BUSINESS data (Postgres) so you can answer ANY question yourself - lead time, DSO, conversion, cohorts, date math, joins - instead of waiting for a purpose-built metric. Relations (already filtered to this workspace, query them by these names): jira (issue tracker: key, summary, status, issueType, assignee, created, resolutionDate, customfield_10039=developer, ...), omie (financial titles: tipo, clienteNome, categoriaDesc, valor, status, dataEmissao, dataVencimento, dataPagamento, numeroPedido, nCodOs, ...), clientes (client base), intervencoes (=field service: technicianName, clientName, brandName, vehicleModelName, type, motivManu, clientPrice, installerPrice, finishedAt, ...). It is plain PostgreSQL: camelCase columns need double quotes (e.g. \"resolutionDate\"); date math via extract(epoch from (a-b))/86400. Run 'SELECT * FROM jira LIMIT 3' first to see columns. Only ONE SELECT (no top-level WITH - use subqueries); cannot touch platform tables; capped 30s / 5000 rows. Read-only.",
    {
      sql: z
        .string()
        .describe(
          "A single read-only SELECT over jira/omie/clientes/intervencoes, e.g. lead time: \"SELECT \\\"assignee\\\", count(*) issues, round(avg(extract(epoch from (\\\"resolutionDate\\\"-\\\"created\\\"))/86400)::numeric,1) lead_days FROM jira WHERE \\\"resolutionDate\\\" IS NOT NULL GROUP BY \\\"assignee\\\" ORDER BY issues DESC\"",
        ),
    },
    async ({ sql }) => ({
      content: [{ type: "text" as const, text: await call(() => api.dataSql(sql)) }],
    }),
  );

  server.tool(
    "lake_sql",
    "Run AD-HOC READ-ONLY SQL over the fleet data lake (ClickHouse) so you can write your OWN joins, window functions and custom aggregations - instead of being limited to pre-modeled metrics. Use this to compute things the structured tools cannot, e.g. availability, custom KPIs, cross-table analysis. Tables: vehicle_daily (gold mart: per vehicle/day - client_id, vehicle_id, day, total_pings, ign_on_pings, moving_pings, idle_pings, dist_km, fuel_avg, speed_max, op_seconds, first_ts, last_ts), vehicle_dim (vehicle_id -> group/model/category/client_id), client_dim (client_id -> client_name). RAW bronze telemetry (~80 cols) via the file() table function: file('<DB_MD_x>/positions/*.parquet','Parquet') - get client ids/paths from lake_sources. Only ONE read statement (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN); capped at 30s / 5000 rows. Tip: run DESCRIBE/SHOW first to learn columns. Read-only.",
    {
      sql: z
        .string()
        .describe(
          "A single read-only SQL statement, e.g. \"SELECT client_id, sum(idle_pings)/sum(total_pings) idle FROM vehicle_daily GROUP BY client_id ORDER BY idle DESC\"",
        ),
    },
    async ({ sql }) => ({
      content: [{ type: "text" as const, text: await call(() => api.lakeSql(sql)) }],
    }),
  );

  server.tool(
    "lake_code_search",
    "Semantic search (RAG over Qdrant) on the indexed PHP business-rule SOURCE CODE. Returns the most relevant code chunks with file path, summary, snippet and a relevance score. Use to answer 'where/how is X implemented in the code' - idle/ociosidade, availability/disponibilidade, odometer/leitura de odometro, measurement and rental rules, etc. Read-only.",
    {
      query: z
        .string()
        .describe("Natural-language query, e.g. 'calculo de ociosidade' or 'leitura de odometro'"),
      topK: z.number().optional().describe("Number of code chunks to return (default 5)"),
    },
    async ({ query, topK }) => ({
      content: [{ type: "text" as const, text: await call(() => api.lakeCodeSearch(query, topK)) }],
    }),
  );

  server.tool(
    "lake_code_list",
    "Browse the indexed code chunks page by page (no query). Returns { items, total, nextOffset }. Pass the opaque nextOffset cursor from a previous call to page forward. Use lake_code_search instead when you know what you are looking for. Read-only.",
    {
      limit: z.number().optional().describe("Chunks per page (default 20, max 200)"),
      offset: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Opaque cursor (nextOffset) from a previous call"),
    },
    async ({ limit, offset }) => ({
      content: [{ type: "text" as const, text: await call(() => api.lakeCodeList(limit, offset)) }],
    }),
  );

  return server;
}
