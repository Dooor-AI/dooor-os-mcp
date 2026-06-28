# Dooor OS MCP

Model Context Protocol (MCP) server for [Dooor OS](https://os-develop.dooor.ai). It exposes your Dooor OS workspace to any MCP-compatible AI client (Claude Code, Claude Desktop, Codex) as a set of tools: query connected data sources, inspect apps and deployments, manage agents and databases, read Harbor governance traces, and more.

Authentication is **headless and workspace-scoped**: a single workspace API key (`dor_sk_...`) carrying the scopes the key was granted. The server never holds secrets of its own; you pass the key via an environment variable.

## Prerequisites

- Node.js 18+
- A Dooor OS workspace API key. Create one in the console under **Settings → API Keys**, granting only the scopes you need (for data exploration: `data-sources:read`, `data-sources:query`, `tools:execute`).

## Install

```bash
git clone https://github.com/Dooor-AI/dooor-os-mcp.git
cd dooor-os-mcp
npm install
npm run build
```

Note the absolute path to the built entrypoint: `.../dooor-os-mcp/dist/index.js`.

## Configure your AI client

### Claude Code

```bash
claude mcp add dooor-os \
  -e DOOOR_API_KEY=dor_sk_your_key_here \
  -- node /absolute/path/to/dooor-os-mcp/dist/index.js
```

Restart Claude Code and run `/mcp`; `dooor-os` should appear.

### Claude Desktop (or a project `.mcp.json`)

```json
{
  "mcpServers": {
    "dooor-os": {
      "command": "node",
      "args": ["/absolute/path/to/dooor-os-mcp/dist/index.js"],
      "env": {
        "DOOOR_API_KEY": "dor_sk_your_key_here"
      }
    }
  }
}
```

### Codex CLI (`~/.codex/config.toml`)

```toml
[mcp_servers.dooor-os]
command = "node"
args    = ["/absolute/path/to/dooor-os-mcp/dist/index.js"]
env     = { DOOOR_API_KEY = "dor_sk_your_key_here" }
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DOOOR_API_KEY` | yes | Your workspace API key (`dor_sk_...`). Determines which workspace and which tools you can use. |
| `DOOOR_BASE_URL` | no | API base URL. Defaults to the managed Dooor OS. Set this for a self-hosted instance. |

The API key is workspace-scoped, so you do not need to set a workspace id.

## Data tools

When the key has `data-sources:read` / `data-sources:query`, the server exposes the workspace data tools, for example:

- `data_ask` — ask a question in natural language; an orchestrator cross-references the connected sources and answers with its steps (source, query, reason).
- `data_sql` — read-only SQL over the connected business sources (Postgres).
- `lake_sql` — read-only SQL over the analytical data lake (ClickHouse).
- `data_sources` / `data_overview` — what is connected and a high-level summary.

## Security

- Grant the **minimum scopes** the key actually needs. A key for data exploration does not need write scopes (`deploy:write`, `databases:write`, `env-vars:write`, ...).
- The key is a credential: do not commit it to a repository or share it in public channels.
- Every request made with a key is logged on the server for governance.

## License

MIT
