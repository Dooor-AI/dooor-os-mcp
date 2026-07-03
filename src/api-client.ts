/**
 * Lightweight HTTP client for Dooor OS REST API.
 * All methods return parsed JSON or throw on non-2xx.
 */
export class DooorApiClient {
  private workspaceId: string = "";

  constructor(
    readonly baseUrl: string,
    private apiKey: string,
    workspaceId?: string,
  ) {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    if (workspaceId) {
      this.workspaceId = workspaceId;
    }
  }

  /**
   * Resolve workspace from the API key itself via /api-keys/whoami.
   * Must be called before any workspace-scoped request if workspaceId
   * was not provided in the constructor.
   */
  async resolveWorkspace(): Promise<{
    workspaceId: string;
    workspaceName: string;
    scopes: string[];
  }> {
    const data = await this.get<{
      workspaceId: string;
      workspace?: { id: string; name: string };
      scopes: string[];
    }>("/api-keys/whoami");

    this.workspaceId = data.workspaceId;

    return {
      workspaceId: data.workspaceId,
      workspaceName: data.workspace?.name ?? "",
      scopes: data.scopes ?? [],
    };
  }

  // -------------------------------------------------------------------------
  // Core HTTP
  // -------------------------------------------------------------------------

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Dooor API ${method} ${path} failed (${res.status}): ${text}`);
    }

    if (res.status === 204) return {} as T;
    return res.json() as Promise<T>;
  }

  private get<T = unknown>(path: string) {
    return this.request<T>("GET", path);
  }
  private post<T = unknown>(path: string, body?: unknown) {
    return this.request<T>("POST", path, body);
  }
  private patch<T = unknown>(path: string, body?: unknown) {
    return this.request<T>("PATCH", path, body);
  }
  private del<T = unknown>(path: string) {
    return this.request<T>("DELETE", path);
  }

  /** Workspace-scoped path helper */
  private ws(path: string) {
    return `/workspaces/${this.workspaceId}${path}`;
  }

  // -------------------------------------------------------------------------
  // Workspace data (removable demo)
  // -------------------------------------------------------------------------

  dataOverview() {
    return this.get(this.ws("/data/overview"));
  }
  dataSources() {
    return this.get(this.ws("/data/sources"));
  }
  dataTable(key: string, limit?: number) {
    const q = limit ? `?limit=${limit}` : "";
    return this.get(this.ws(`/data/table/${key}${q}`));
  }
  dataAsk(question: string) {
    return this.post(this.ws("/data/ask"), { question });
  }
  dataInsightsLatest() {
    return this.get(this.ws("/data/insights/latest"));
  }

  // -------------------------------------------------------------------------
  // Data lake (telemetry data lake - ClickHouse)
  // -------------------------------------------------------------------------

  lakeCatalog() {
    return this.get(this.ws("/data/lake/catalog"));
  }
  lakeAsk(question: string) {
    return this.post(this.ws("/data/lake/ask"), { question });
  }
  lakeQuery(spec: Record<string, unknown>) {
    return this.post(this.ws("/data/lake/query"), spec);
  }
  lakeDashboard(prompt: string) {
    return this.post(this.ws("/data/lake/dashboard"), { prompt });
  }
  lakeSources() {
    return this.get(this.ws("/data/lake/sources"));
  }
  lakeBrowse(params: {
    layer: string;
    client?: string;
    table?: string;
    vehicleId?: string;
    limit?: number;
  }) {
    const qs = new URLSearchParams();
    qs.set("layer", params.layer);
    if (params.client) qs.set("client", params.client);
    if (params.table) qs.set("table", params.table);
    if (params.vehicleId) qs.set("vehicleId", params.vehicleId);
    if (params.limit != null) qs.set("limit", String(params.limit));
    return this.get(this.ws(`/data/lake/browse?${qs.toString()}`));
  }
  lakeCodeSearch(query: string, topK?: number) {
    return this.post(this.ws("/data/oltp/code/search"), { query, topK });
  }
  lakeSql(sql: string) {
    return this.post(this.ws("/data/lake/sql"), { sql });
  }
  dataSql(sql: string) {
    return this.post(this.ws("/data/sql"), { sql });
  }
  lakeCodeList(limit?: number, offset?: string | number) {
    const qs = new URLSearchParams();
    if (limit != null) qs.set("limit", String(limit));
    if (offset != null && String(offset) !== "0") qs.set("offset", String(offset));
    return this.get(this.ws(`/data/oltp/code/list?${qs.toString()}`));
  }

  // -------------------------------------------------------------------------
  // Apps
  // -------------------------------------------------------------------------

  listApps(params?: { page?: number; limit?: number; status?: string; search?: string }) {
    const qs = new URLSearchParams();
    if (params?.page) qs.set("page", String(params.page));
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.status) qs.set("status", params.status);
    if (params?.search) qs.set("search", params.search);
    const q = qs.toString();
    return this.get(this.ws(`/apps${q ? `?${q}` : ""}`));
  }

  createApp(data: {
    name: string;
    slug: string;
    description?: string;
    type?: string;
    gitRepoUrl?: string;
    gitBranch?: string;
    gitInstallationId?: string;
    dockerfilePath?: string;
    autoDeploy?: boolean;
  }) {
    return this.post(this.ws("/apps"), data);
  }

  getApp(appId: string) {
    return this.get(this.ws(`/apps/${appId}`));
  }

  updateApp(appId: string, data: Record<string, unknown>) {
    return this.patch(this.ws(`/apps/${appId}`), data);
  }

  deleteApp(appId: string, permanent = false) {
    return this.del(this.ws(`/apps/${appId}${permanent ? "/permanent" : ""}`));
  }

  getAppStats() {
    return this.get(this.ws("/apps/stats"));
  }

  getPipelineState(appId: string) {
    return this.get(this.ws(`/apps/${appId}/pipeline-state`));
  }

  // -------------------------------------------------------------------------
  // Deploy
  // -------------------------------------------------------------------------

  triggerDeploy(data: {
    appId: string;
    gitBranch?: string;
    gitCommitSha?: string;
    source?: {
      type: "GIT" | "UPLOAD" | "IMAGE";
      uploadId?: string;
      imageRef?: string;
      registryAuthRef?: string;
      gitRepoUrl?: string;
      gitBranch?: string;
      gitInstallationId?: string;
    };
  }) {
    return this.post(this.ws("/deploy"), data);
  }

  // -------------------------------------------------------------------------
  // App source (GIT / UPLOAD / IMAGE)
  // -------------------------------------------------------------------------

  getAppSource(appId: string) {
    return this.get(this.ws(`/apps/${appId}/source`));
  }

  setAppSource(appId: string, data: {
    type: "GIT" | "UPLOAD" | "IMAGE";
    gitRepoUrl?: string;
    gitBranch?: string;
    gitProvider?: "GITHUB" | "GITLAB" | "BITBUCKET";
    gitInstallationId?: string;
    imageRef?: string;
    imageRegistryAuthRef?: string;
  }) {
    return this.patch(this.ws(`/apps/${appId}/source`), data);
  }

  // -------------------------------------------------------------------------
  // Uploads (tarball-based deploys)
  // -------------------------------------------------------------------------

  initUpload(
    appId: string,
    data: { sizeBytes: number; sha256?: string },
  ): Promise<{
    uploadId: string;
    bucketKey: string;
    presignedPutUrl: string;
    headers: Record<string, string>;
    expiresAt: string;
    maxSizeBytes: number;
  }> {
    return this.post(this.ws(`/apps/${appId}/uploads/init`), data) as any;
  }

  completeUpload(
    appId: string,
    uploadId: string,
    data: { sha256: string },
  ): Promise<{ uploadId: string; status: string; sizeBytes: number | null }> {
    return this.post(
      this.ws(`/apps/${appId}/uploads/${uploadId}/complete`),
      data,
    ) as any;
  }

  /**
   * Direct PUT to the presigned URL returned by initUpload.
   * Bypasses Bearer auth because the URL itself authorizes the write.
   */
  async putToPresignedUrl(
    url: string,
    headers: Record<string, string>,
    body: Buffer,
  ): Promise<void> {
    const ab = body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    ) as ArrayBuffer;
    const res = await fetch(url, {
      method: "PUT",
      headers,
      body: ab,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Presigned PUT failed (${res.status}): ${text.slice(0, 500)}`,
      );
    }
  }

  listDeployments(appId: string, params?: { page?: number; limit?: number; status?: string }) {
    const qs = new URLSearchParams({ appId });
    if (params?.page) qs.set("page", String(params.page));
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.status) qs.set("status", params.status);
    return this.get(this.ws(`/deploy?${qs.toString()}`));
  }

  getDeployment(deployId: string) {
    return this.get(this.ws(`/deploy/${deployId}`));
  }

  getRuntimeStatus(deployId: string) {
    return this.get(this.ws(`/deploy/${deployId}/runtime-status`));
  }

  getBuildLogs(deployId: string) {
    return this.get(this.ws(`/deploy/${deployId}/logs`));
  }

  scaleApp(appId: string, replicas: number) {
    return this.post(this.ws("/deploy/scale"), { appId, replicas });
  }

  rollback(deployId: string) {
    return this.post(this.ws(`/deploy/${deployId}/rollback`));
  }

  listRevisions(appId: string) {
    return this.get(this.ws(`/deploy/apps/${appId}/revisions`));
  }

  setTraffic(appId: string, splits: Array<{ revisionId: string; percent: number; tag?: string }>) {
    return this.post(this.ws(`/deploy/apps/${appId}/traffic`), { splits });
  }

  // -------------------------------------------------------------------------
  // Git
  // -------------------------------------------------------------------------

  getGitInstallUrl() {
    return this.get(this.ws("/git/install-url"));
  }

  listGitInstallations(params?: { page?: number; limit?: number }) {
    const qs = new URLSearchParams();
    if (params?.page) qs.set("page", String(params.page));
    if (params?.limit) qs.set("limit", String(params.limit));
    const q = qs.toString();
    return this.get(this.ws(`/git/installations${q ? `?${q}` : ""}`));
  }

  listRepos(installationId: string, params?: { page?: number; limit?: number }) {
    const qs = new URLSearchParams({ installationId });
    if (params?.page) qs.set("page", String(params.page));
    if (params?.limit) qs.set("limit", String(params.limit));
    return this.get(this.ws(`/git/repos?${qs.toString()}`));
  }

  listBranches(owner: string, repo: string, installationId: string) {
    return this.get(
      this.ws(`/git/repos/${owner}/${repo}/branches?installationId=${installationId}`),
    );
  }

  // -------------------------------------------------------------------------
  // Env Vars
  // -------------------------------------------------------------------------

  listEnvVars(appId: string) {
    return this.get(this.ws(`/apps/${appId}/env-vars`));
  }

  createEnvVar(appId: string, data: { key: string; value: string; isSecret?: boolean }) {
    return this.post(this.ws(`/apps/${appId}/env-vars`), data);
  }

  bulkSetEnvVars(appId: string, vars: Array<{ key: string; value: string; isSecret?: boolean }>) {
    return this.post(this.ws(`/apps/${appId}/env-vars/bulk`), { appId, vars });
  }

  syncEnvVars(appId: string) {
    return this.post(this.ws(`/apps/${appId}/env-vars/sync`));
  }

  deleteEnvVar(appId: string, envVarId: string) {
    return this.del(this.ws(`/apps/${appId}/env-vars/${envVarId}`));
  }

  // -------------------------------------------------------------------------
  // Databases
  // -------------------------------------------------------------------------

  listDatabases(params?: { engine?: string; status?: string; search?: string }) {
    const qs = new URLSearchParams();
    if (params?.engine) qs.set("engine", params.engine);
    if (params?.status) qs.set("status", params.status);
    if (params?.search) qs.set("search", params.search);
    const q = qs.toString();
    return this.get(this.ws(`/databases${q ? `?${q}` : ""}`));
  }

  createDatabase(data: {
    name: string;
    slug: string;
    engine: string;
    version?: string;
    cpu?: string;
    memory?: string;
    storageGb?: number;
    storageClass?: string;
    highAvailability?: boolean;
    projectId?: string;
  }) {
    return this.post(this.ws("/databases"), data);
  }

  attachDatabase(
    dbId: string,
    data: { appId: string; mountPath?: string },
  ) {
    return this.post(this.ws(`/databases/${dbId}/attachments`), data);
  }

  detachDatabase(dbId: string, appId: string) {
    return this.del(this.ws(`/databases/${dbId}/attachments/${appId}`));
  }

  listAppDatabases(appId: string) {
    return this.get(this.ws(`/apps/${appId}/databases`));
  }

  getDatabase(dbId: string) {
    return this.get(this.ws(`/databases/${dbId}`));
  }

  getDatabaseStatus(dbId: string) {
    return this.get(this.ws(`/databases/${dbId}/status`));
  }

  getDatabaseConnection(dbId: string) {
    return this.get(this.ws(`/databases/${dbId}/connection`));
  }

  queryDatabase(dbId: string, sql: string, maxRows?: number) {
    return this.post(this.ws(`/databases/${dbId}/query`), { sql, maxRows });
  }

  deleteDatabase(dbId: string) {
    return this.del(this.ws(`/databases/${dbId}`));
  }

  // -------------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------------

  listAgents(params?: { page?: number; limit?: number; status?: string; search?: string }) {
    const qs = new URLSearchParams();
    if (params?.page) qs.set("page", String(params.page));
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.status) qs.set("status", params.status);
    if (params?.search) qs.set("search", params.search);
    const q = qs.toString();
    return this.get(this.ws(`/agents${q ? `?${q}` : ""}`));
  }

  createAgent(data: {
    name: string;
    slug?: string;
    description?: string;
    templateId?: string;
    soul?: string;
    modelProvider?: string;
    modelName?: string;
    tools?: unknown[];
  }) {
    return this.post(this.ws("/agents"), data);
  }

  getAgent(agentId: string) {
    return this.get(this.ws(`/agents/${agentId}`));
  }

  updateAgent(agentId: string, data: Record<string, unknown>) {
    return this.patch(this.ws(`/agents/${agentId}`), data);
  }

  deleteAgent(agentId: string, permanent = false) {
    return this.del(this.ws(`/agents/${agentId}${permanent ? "/permanent" : ""}`));
  }

  deployAgent(agentId: string) {
    return this.post(this.ws(`/agents/${agentId}/deploy`));
  }

  listAgentDeployments(agentId: string, limit?: number) {
    const qs = limit ? `?limit=${limit}` : "";
    return this.get(this.ws(`/agents/${agentId}/deployments${qs}`));
  }

  getAgentDeployment(agentId: string, deploymentId: string) {
    return this.get(this.ws(`/agents/${agentId}/deployments/${deploymentId}`));
  }

  stopAgent(agentId: string) {
    return this.post(this.ws(`/agents/${agentId}/stop`));
  }

  restartAgent(agentId: string) {
    return this.post(this.ws(`/agents/${agentId}/restart`));
  }

  chatWithAgent(agentId: string, prompt: string, sessionId?: string) {
    return this.post(this.ws(`/agents/${agentId}/run`), { prompt, sessionId });
  }

  listAgentTemplates() {
    return this.get(this.ws("/agents/templates"));
  }

  // -------------------------------------------------------------------------
  // Monitoring
  // -------------------------------------------------------------------------

  getAppHealth(appId: string) {
    return this.get(this.ws(`/monitoring/apps/${appId}/health`));
  }

  getAppMetrics(appId: string, period = "24h") {
    return this.get(this.ws(`/monitoring/apps/${appId}/metrics?period=${period}`));
  }

  getAppLogs(appId: string, params?: { limit?: number; severity?: string }) {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.severity) qs.set("severity", params.severity);
    const q = qs.toString();
    return this.get(this.ws(`/monitoring/apps/${appId}/logs${q ? `?${q}` : ""}`));
  }

  getWorkspaceOverview() {
    return this.get(this.ws("/monitoring/overview"));
  }

  listAlerts(params?: { appId?: string; resolved?: boolean; limit?: number }) {
    const qs = new URLSearchParams();
    if (params?.appId) qs.set("appId", params.appId);
    if (params?.resolved !== undefined) qs.set("resolved", String(params.resolved));
    if (params?.limit) qs.set("limit", String(params.limit));
    const q = qs.toString();
    return this.get(this.ws(`/monitoring/alerts${q ? `?${q}` : ""}`));
  }

  // -------------------------------------------------------------------------
  // API Keys
  // -------------------------------------------------------------------------

  listApiKeys() {
    return this.get(this.ws("/api-keys"));
  }

  createApiKey(name: string, scopes: string[], expiresAt?: string) {
    return this.post(this.ws("/api-keys"), { name, scopes, expiresAt });
  }

  revokeApiKey(keyId: string) {
    return this.del(this.ws(`/api-keys/${keyId}`));
  }
}
