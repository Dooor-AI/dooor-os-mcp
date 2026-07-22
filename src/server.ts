import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { DooorApiClient } from "./api-client.js";
import { buildSourceTarball, MAX_TARBALL_BYTES } from "./archiver.js";
import {
  currentCorrelationId,
  logInternalError,
  publicFailure,
} from "./error-handling.js";
import { API_KEY_SCOPES, MCP_DEPLOY_AUTOMATION_SCOPES } from "./scopes.js";

/** Helper: wrap API calls and return formatted JSON */
async function call<T>(fn: () => Promise<T>): Promise<string> {
  try {
    const result = await fn();
    return JSON.stringify(result, null, 2);
  } catch (err) {
    const correlationId = currentCorrelationId();
    logInternalError("MCP tool call failed", err, correlationId);
    return JSON.stringify(publicFailure(err, correlationId));
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
      "Answer grounded business questions over the operational sources advertised by the active workspace product.",
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
      "Explore and analyze high-volume product data through curated tools or read-only analytical SQL.",
    readOnly: true,
  },
  {
    family: "lake_code",
    tools: ["lake_code_search", "lake_code_list"],
    useFor: "Search or page through business-rule source code advertised by the active workspace product.",
    readOnly: true,
  },
] as const;

type CapabilityProbe<T> =
  | { name: string; ok: true; data: T }
  | {
      name: string;
      ok: false;
      error: string;
      correlationId: string;
    };

type ProductCapabilityShape = {
  key?: unknown;
  family?: unknown;
  mcpTools?: unknown;
};

function productCapabilitySummary(payload: unknown): {
  keys: string[];
  families: string[];
  mcpTools: string[];
} {
  const envelope =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  const products = Array.isArray(envelope.products)
    ? envelope.products
    : Array.isArray(payload)
      ? payload
      : [];
  const keys = new Set<string>();
  const families = new Set<string>();
  const mcpTools = new Set<string>();

  for (const product of products) {
    if (typeof product !== "object" || product === null) continue;
    const capabilities = (product as Record<string, unknown>).capabilities;
    if (!Array.isArray(capabilities)) continue;
    for (const rawCapability of capabilities) {
      if (typeof rawCapability !== "object" || rawCapability === null) continue;
      const capability = rawCapability as ProductCapabilityShape;
      if (typeof capability.key === "string") keys.add(capability.key);
      if (typeof capability.family === "string") {
        families.add(capability.family);
      }
      if (Array.isArray(capability.mcpTools)) {
        for (const tool of capability.mcpTools) {
          if (typeof tool === "string") mcpTools.add(tool);
        }
      }
    }
  }

  return {
    keys: [...keys],
    families: [...families],
    mcpTools: [...mcpTools],
  };
}

function hasRows(payload: unknown): boolean {
  if (Array.isArray(payload)) return payload.length > 0;
  if (typeof payload !== "object" || payload === null) return false;
  const count = (payload as Record<string, unknown>).count;
  if (typeof count === "number") return count > 0;
  return Object.values(payload as Record<string, unknown>).some(
    (value) => Array.isArray(value) && value.length > 0,
  );
}

function collectionRows(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) {
    return payload.filter(
      (row): row is Record<string, unknown> =>
        typeof row === "object" && row !== null && !Array.isArray(row),
    );
  }
  if (typeof payload !== "object" || payload === null) return [];
  const envelope = payload as Record<string, unknown>;
  for (const key of ["data", "items", "sources", "connections"]) {
    if (Array.isArray(envelope[key])) return collectionRows(envelope[key]);
  }
  return [];
}

function compactCollectionProbe(payload: unknown): {
  count: number;
  statuses: Record<string, number>;
  totalRecords: number | null;
  freshness: { latest: string | null; oldest: string | null };
} {
  const rows = collectionRows(payload);
  const statuses: Record<string, number> = {};
  let totalRecords = 0;
  let hasRecordCount = false;
  const timestamps: string[] = [];

  for (const row of rows) {
    const status = typeof row.status === "string" ? row.status : "unknown";
    statuses[status] = (statuses[status] ?? 0) + 1;
    if (typeof row.recordCount === "number") {
      totalRecords += row.recordCount;
      hasRecordCount = true;
    }
    for (const key of ["lastSyncAt", "lastQueryAt", "lastTestedAt", "updatedAt"]) {
      const value = row[key];
      if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
        timestamps.push(value);
        break;
      }
    }
  }
  timestamps.sort((left, right) => Date.parse(left) - Date.parse(right));
  return {
    count: rows.length,
    statuses,
    totalRecords: hasRecordCount ? totalRecords : null,
    freshness: {
      latest: timestamps.at(-1) ?? null,
      oldest: timestamps[0] ?? null,
    },
  };
}

function compactLakeProbe(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null) {
    return { count: 0, totals: {}, freshness: null, layerCount: 0 };
  }
  const summary = payload as Record<string, unknown>;
  const totals =
    typeof summary.totals === "object" && summary.totals !== null
      ? summary.totals
      : {};
  const freshness =
    typeof summary.freshness === "object" && summary.freshness !== null
      ? summary.freshness
      : null;
  const count =
    typeof (totals as Record<string, unknown>).clients === "number"
      ? ((totals as Record<string, unknown>).clients as number)
      : 0;
  return {
    count,
    totals,
    freshness,
    layerCount: Array.isArray(summary.layers) ? summary.layers.length : 0,
  };
}

async function probe<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<CapabilityProbe<T>> {
  try {
    return { name, ok: true, data: await fn() };
  } catch (err) {
    const correlationId = currentCorrelationId();
    logInternalError(`MCP capability probe '${name}' failed`, err, correlationId);
    return { name, ok: false, ...publicFailure(err, correlationId) };
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
export interface CreateServerOptions {
  /**
   * Enables tools that read paths from the machine running the MCP process.
   * This must be opted into by trusted local transports such as stdio.
   */
  localFilesystemAccess?: boolean;
  /**
   * Product-scoped tools advertised by GET /data-products for this key's
   * workspace. When provided, product tools fail closed and only these names
   * are registered. Platform and live-connection discovery tools remain
   * available according to the API key's server-side scopes.
   */
  enabledProductTools?: ReadonlySet<string>;
}

export function enabledProductToolsFrom(payload: unknown): ReadonlySet<string> {
  return new Set(productCapabilitySummary(payload).mcpTools);
}

export function createServer(
  api: DooorApiClient,
  options: CreateServerOptions = {},
): McpServer {
  const productToolEnabled = (name: string) =>
    options.enabledProductTools === undefined ||
    options.enabledProductTools.has(name);
  const enabledProductToolNames = options.enabledProductTools
    ? [...options.enabledProductTools].sort()
    : [];
  const productToolInstructions = options.enabledProductTools
    ? enabledProductToolNames.length > 0
      ? `Workspace-advertised product tools: ${enabledProductToolNames.join(", ")}.`
      : "This workspace advertises no product-specific data tools."
    : "Call data_products to discover the workspace's product-specific data tools.";
  const server = new McpServer(
    {
      name: "dooor-os",
      version: "0.1.0",
    },
    {
      instructions:
        "Dooor OS workspace access through MCP. Start with capabilities to inspect the active workspace, " +
        "API-key scopes, advertised product capabilities and connected data sources. " +
        `${productToolInstructions}\n\n` +
        "Only call a product tool that appears in this server's tool list. Product data tools are read-only, " +
        "workspace-scoped and selected from the active product contract. Use data_sources before data_sql, " +
        "and prefer data_ask for grounded business questions. Do not infer invoice, payment, payout, cash, " +
        "revenue or causality unless the returned sources and fields explicitly support that meaning.\n\n" +
        "For live operational connections, call data_connections, then data_connection_capabilities, then " +
        "data_connection_read with an advertised list/get operation. Fixed source filters are authoritative, " +
        "credentials are never returned and source writes are unavailable.\n\n" +
        "Platform tools can mutate Dooor OS resources. Use them only when the user explicitly requests that " +
        "operation. For a deployed app, use a dedicated least-privilege workspace API key and the REST API " +
        "described by integration_guide. Never hardcode a key or expose it to browser code.",
    },
  );

  server.tool(
    "capabilities",
    "Whoami plus a compact map of this MCP server: active workspace, API key scopes, tool families, and optional read-only probes for connected data sources. Use first when you need to know what this key can access.",
    {
      includeProbes: z
        .boolean()
        .optional()
        .describe("Run compact read-only count/status/freshness probes only for tool families advertised by the workspace products. Default false."),
    },
    async ({ includeProbes = false }) => ({
      content: [
        {
          type: "text" as const,
          text: await call(async () => {
            const [workspace, products] = await Promise.all([
              api.resolveWorkspace(),
              api.dataProducts(),
            ]);
            const productCapabilities = productCapabilitySummary(products);
            const advertisedTools = new Set(productCapabilities.mcpTools);
            const probes: CapabilityProbe<unknown>[] = [];

            let connectionsProbe: CapabilityProbe<unknown> | undefined;
            if (includeProbes) {
              const requestedProbes: Promise<CapabilityProbe<unknown>>[] = [
                probe("data_connections", async () =>
                  compactCollectionProbe(await api.dataConnections()),
                ),
              ];
              if (advertisedTools.has("data_sources")) {
                requestedProbes.push(
                  probe("data_sources", async () =>
                    compactCollectionProbe(await api.dataSources()),
                  ),
                );
              }
              if (advertisedTools.has("lake_sources")) {
                requestedProbes.push(
                  probe("lake_sources", async () =>
                    compactLakeProbe(await api.lakeSourcesSummary()),
                  ),
                );
              }
              probes.push(...(await Promise.all(requestedProbes)));
              connectionsProbe = probes.find(
                (candidate) => candidate.name === "data_connections",
              );
            }

            const liveConnectionsAvailable = connectionsProbe?.ok
              ? hasRows(connectionsProbe.data)
              : undefined;
            const toolFamilies = TOOL_FAMILIES.map((family) => {
              if (family.family === "platform") {
                return { ...family, availability: "available" as const };
              }
              if (family.family === "live_data_connections") {
                return {
                  ...family,
                  availability:
                    liveConnectionsAvailable === undefined
                      ? ("not_probed" as const)
                      : liveConnectionsAvailable
                        ? ("available" as const)
                        : ("unavailable" as const),
                };
              }
              const availableTools = family.tools.filter((tool) =>
                advertisedTools.has(tool),
              );
              return {
                ...family,
                tools: availableTools,
                availability:
                  availableTools.length > 0
                    ? ("available" as const)
                    : ("unavailable" as const),
              };
            });

            return {
              server: "dooor-os",
              version: "0.1.0",
              workspace,
              productCapabilities,
              toolFamilies,
              probes,
            };
          }),
        },
      ],
    }),
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
        "  if (!r.ok) throw new Error(`dooor sql failed (${r.status})`);",
        "  return r.json();",
        "}",
        "",
        "export async function dooorAsk(question: string) {",
        "  const ws = await workspaceId();",
        "  const r = await fetch(`${BASE}/workspaces/${ws}/data/ask`, {",
        "    method: 'POST', headers: H, body: JSON.stringify({ question }),",
        "  });",
        "  if (!r.ok) throw new Error(`dooor ask failed (${r.status})`);",
        "  return r.json();",
        "}",
        "",
        "export async function dooorConnections() {",
        "  const ws = await workspaceId();",
        "  const r = await fetch(`${BASE}/workspaces/${ws}/data-sources`, { headers: H });",
        "  if (!r.ok) throw new Error(`dooor connections failed (${r.status})`);",
        "  return r.json();",
        "}",
        "",
        "export async function dooorConnectionCapabilities(sourceId: string) {",
        "  const ws = await workspaceId();",
        "  const id = encodeURIComponent(sourceId);",
        "  const r = await fetch(`${BASE}/workspaces/${ws}/data-sources/${id}/capabilities`, { headers: H });",
        "  if (!r.ok) throw new Error(`dooor capabilities failed (${r.status})`);",
        "  return r.json();",
        "}",
        "",
        "export async function dooorConnectionRead(sourceId: string, input: {",
        "  entity: string; operation: 'list' | 'get'; id?: string;",
        "  filter?: Record<string, unknown>; cursor?: string; maxRows?: number;",
        "}) {",
        "  const ws = await workspaceId();",
        "  const id = encodeURIComponent(sourceId);",
        "  const r = await fetch(`${BASE}/workspaces/${ws}/data-sources/${id}/operation`, {",
        "    method: 'POST', headers: H, body: JSON.stringify(input),",
        "  });",
        "  if (!r.ok) throw new Error(`dooor connection read failed (${r.status})`);",
        "  return r.json();",
        "}",
        "```",
        "",
        "For live reads, list connections, inspect capabilities, then call only an advertised list/get operation.",
        "Configured fixed filters are enforced by Dooor and cannot be overridden by the app.",
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

  if (options.localFilesystemAccess === true) {
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
        tarballPath: z
          .string()
          .describe("Absolute path to .tar.gz on the user's machine"),
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
  }

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
    "Execute one allowlisted read-only list/get operation through Dooor. Call data_connection_capabilities first and use exactly one entity and operation it returns. This tool never exposes source credentials and never performs source writes.",
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

  if (productToolEnabled("data_overview")) {
    server.tool(
      "data_overview",
      "Get the aggregated overview exposed by the active data product for this workspace. The available domains and metrics are product-defined. Call data_products first when the workspace is new. Read-only.",
      {},
      async () => ({
        content: [{ type: "text" as const, text: await call(() => api.dataOverview()) }],
      }),
    );
  }

  if (productToolEnabled("data_ask")) {
    server.tool(
      "data_ask",
      "PRIMARY data tool. Ask a natural-language business question (PT-BR or EN) about the workspace's active data product and receive a grounded answer with evidence from its governed sources. Available subjects depend on the product capabilities returned by data_products. Read-only.",
      {
        question: z.string().describe("Business question in natural language (PT-BR or EN)"),
      },
      async ({ question }) => ({
        content: [{ type: "text" as const, text: await call(() => api.dataAsk(question)) }],
      }),
    );
  }

  if (productToolEnabled("data_table")) {
    server.tool(
      "data_table",
      "Preview rows from one source exposed by the active data product provider. Call data_products first and use this tool only when data_table is advertised by an enabled capability. Read-only.",
      {
        key: z
          .string()
          .min(1)
          .describe("Provider-defined source key. Discover valid keys with data_sources."),
        limit: z.number().optional().describe("Max rows (default 25, max 100)"),
      },
      async ({ key, limit }) => ({
        content: [{ type: "text" as const, text: await call(() => api.dataTable(key, limit)) }],
      }),
    );
  }

  if (productToolEnabled("data_sources")) {
    server.tool(
      "data_sources",
      "List the governed sources exposed by the active data product, including the metadata and statistics its provider makes available. Use this to discover what can be queried. Read-only.",
      {},
      async () => ({
        content: [{ type: "text" as const, text: await call(() => api.dataSources()) }],
      }),
    );
  }

  if (productToolEnabled("data_insights")) {
    server.tool(
      "data_insights",
      "Get the latest proactive insight digest discovered across the connected sources (ranked findings with metric, value, evidence and recommended action). Read-only.",
      {},
      async () => ({
        content: [{ type: "text" as const, text: await call(() => api.dataInsightsLatest()) }],
      }),
    );
  }

  // ── Product analytical lake ──

  if (productToolEnabled("lake_ask")) {
    server.tool(
      "lake_ask",
      "Ask a natural-language question (PT-BR or EN) over the active product's analytical lake. The provider plans a governed query grounded in its catalog and returns the answer with data. Read-only.",
      {
        question: z.string().describe("Analytical question in natural language (PT-BR or EN)"),
      },
      async ({ question }) => ({
        content: [{ type: "text" as const, text: await call(() => api.lakeAsk(question)) }],
      }),
    );
  }

  if (productToolEnabled("lake_dashboard")) {
    server.tool(
      "lake_dashboard",
      "Generate a multi-panel analytical dashboard from a natural-language brief. The active product provider selects governed metrics and dimensions from its catalog, executes the panels, and returns data ready to render. Read-only.",
      {
        prompt: z.string().describe("What the analytical dashboard should cover"),
      },
      async ({ prompt }) => ({
        content: [{ type: "text" as const, text: await call(() => api.lakeDashboard(prompt)) }],
      }),
    );
  }

  if (productToolEnabled("lake_query")) {
    server.tool(
      "lake_query",
      "Run a structured, validated aggregation over the active product's analytical lake (no raw SQL). Provide measures and dimensions from lake_catalog. Every key is validated before execution. Read-only.",
      {
        measures: z.array(z.string()).describe("Measure keys returned by lake_catalog"),
        dimensions: z.array(z.string()).optional().describe("Dimension keys returned by lake_catalog"),
        granularity: z.enum(["day", "week", "month"]).optional().describe("Time bucketing"),
        orderBy: z.string().optional().describe("Measure key to sort by (desc)"),
        limit: z.number().optional(),
      },
      async (spec) => ({
        content: [{ type: "text" as const, text: await call(() => api.lakeQuery(spec)) }],
      }),
    );
  }

  if (productToolEnabled("lake_catalog")) {
    server.tool(
      "lake_catalog",
      "Get the active product's analytical catalog: available datasets, measures, dimensions and business-rule glossary. Use it to discover valid keys for lake_query. Read-only.",
      {},
      async () => ({
        content: [{ type: "text" as const, text: await call(() => api.lakeCatalog()) }],
      }),
    );
  }

  if (productToolEnabled("lake_sources")) {
    server.tool(
      "lake_sources",
      "Page or summarize the raw and curated layers exposed by the active product's analytical lake. Results are bounded by client and table limits. Use this to discover valid source, layer and table identifiers before calling lake_browse. Read-only.",
      {
        summary: z.boolean().optional().describe("Return counts and Gold freshness only. Default false."),
        page: z.number().int().min(1).optional().describe("Client page. Default 1."),
        limit: z.number().int().min(1).max(50).optional().describe("Clients per page. Default 10, maximum 50."),
        tableLimit: z.number().int().min(1).max(200).optional().describe("Tables per category and client. Default 50, maximum 200."),
        search: z.string().max(80).optional().describe("Filter by client ID/name or table name."),
      },
      async ({ summary = false, page = 1, limit = 10, tableLimit = 50, search }) => ({
        content: [{
          type: "text" as const,
          text: await call(() =>
            summary
              ? api.lakeSourcesSummary()
              : api.lakeSources({ page, limit, tableLimit, search }),
          ),
        }],
      }),
    );
  }

  if (productToolEnabled("lake_browse")) {
    server.tool(
      "lake_browse",
      "Browse raw or curated rows from a layer exposed by the active product provider. Returns typed columns, rows, executed SQL and server-side query time. Discover valid identifiers with lake_sources first. Read-only, max 1000 rows.",
      {
        layer: z
          .string()
          .min(1)
          .describe("Provider layer identifier returned by lake_sources"),
        client: z.string().optional().describe("Optional provider dataset identifier"),
        table: z.string().optional().describe("Optional provider table identifier"),
        entityId: z.string().optional().describe("Optional provider-specific entity filter"),
        limit: z.number().optional().describe("Max rows (default 50, max 1000)"),
      },
      async ({ entityId, ...params }) => ({
        content: [
          {
            type: "text" as const,
            text: await call(() =>
              api.lakeBrowse({ ...params, vehicleId: entityId }),
            ),
          },
        ],
      }),
    );
  }

  if (productToolEnabled("data_sql")) {
    server.tool(
      "data_sql",
      "Run one ad-hoc read-only SQL query over the workspace-scoped business relations exposed by the active data product. Relation names and columns are product-defined, so inspect data_products and data_sources first. Platform tables and mutating statements are blocked; execution and row limits are enforced server-side. Read-only.",
      {
        sql: z
          .string()
          .describe(
            "A single read-only SQL statement over relations exposed by the active data product",
          ),
      },
      async ({ sql }) => ({
        content: [{ type: "text" as const, text: await call(() => api.dataSql(sql)) }],
      }),
    );
  }

  if (productToolEnabled("lake_sql")) {
    server.tool(
      "lake_sql",
      "Run one ad-hoc read-only SQL statement over the active product's analytical lake for custom joins, windows or aggregations. Discover datasets with lake_sources or lake_catalog first. Statement, timeout and row limits are enforced server-side. Read-only.",
      {
        sql: z
          .string()
          .describe(
            "A single read-only analytical SQL statement over datasets exposed by the active data product",
          ),
      },
      async ({ sql }) => ({
        content: [{ type: "text" as const, text: await call(() => api.lakeSql(sql)) }],
      }),
    );
  }

  if (productToolEnabled("lake_code_search")) {
    server.tool(
      "lake_code_search",
      "Semantic search over the business-rule source code indexed for the active product. Returns relevant code chunks with file path, summary, snippet and score. Read-only.",
      {
        query: z
          .string()
          .describe("Natural-language implementation or business-rule query"),
        topK: z.number().optional().describe("Number of code chunks to return (default 5)"),
      },
      async ({ query, topK }) => ({
        content: [{ type: "text" as const, text: await call(() => api.lakeCodeSearch(query, topK)) }],
      }),
    );
  }

  if (productToolEnabled("lake_code_list")) {
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
  }

  return server;
}
