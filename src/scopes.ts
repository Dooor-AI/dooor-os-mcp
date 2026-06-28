export const API_KEY_SCOPES = [
  "agents:read",
  "agents:write",
  "agents:chat",
  "apps:read",
  "apps:write",
  "api-keys:read",
  "api-keys:write",
  "databases:read",
  "databases:write",
  "deploy:read",
  "deploy:write",
  "env-vars:read",
  "env-vars:write",
  "git:read",
  "git:write",
  "harbor:read",
  "harbor:write",
  "monitoring:read",
  "monitoring:write",
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const MCP_DEPLOY_AUTOMATION_SCOPES: ApiKeyScope[] = [
  "apps:read",
  "apps:write",
  "deploy:read",
  "deploy:write",
  "env-vars:read",
  "env-vars:write",
  "git:read",
  "monitoring:read",
];
