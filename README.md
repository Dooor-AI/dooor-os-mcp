# Dooor OS MCP server

Model Context Protocol (MCP) server for the Dooor OS platform. Exposes the
workspace's apps, deploys, git, databases, agents, monitoring and connected
business data as MCP tools so an MCP client (Claude Code, Claude Desktop, etc.)
can operate the platform on your behalf.

Every tool is scoped to a single workspace, resolved from the API key you
provide. All `data_*` and `lake_*` tools are read-only.

## Tool families

Start with `capabilities` when connecting a new client. It returns the active
workspace, API key scopes, tool families and optional read-only probes for the
connected data sources.

* `capabilities`: workspace whoami, scopes, family map and source probes.
* Platform tools: apps, deploys, git repos, env vars, databases, agents and
  monitoring.
* `data_*`: business questions over connected operational sources such as field
  service, finance, issues and client records. Use `data_ask` first for most
  natural-language questions.
* `lake_*`: telemetry or high-volume analytical data through curated tools,
  raw browse, catalog discovery and read-only SQL.
* `lake_code_*`: search or page through indexed legacy business-rule source
  code.

## Two ways to connect

| Mode | Transport | Where the API key comes from |
|------|-----------|------------------------------|
| Local (default) | stdio | `DOOOR_API_KEY` environment variable |
| Remote (hosted) | Streamable HTTP | `X-Api-Key: dor_sk_...` header, per request |

You only need one. Most users run the local stdio server; the hosted server is
for clients that prefer not to clone and build anything.

## Local (stdio)

Clone, install, build:

```bash
git clone https://github.com/Dooor-AI/dooor-os-mcp.git
cd dooor-os-mcp
npm install
npm run build
```

Then register it with your MCP client, passing your workspace API key via the
`DOOOR_API_KEY` environment variable. Example MCP client config:

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

Optional env:

- `DOOOR_BASE_URL` - override the API base URL (default
  `https://os-develop.dooor.ai/api/v1`).

## Remote (hosted) server

Instead of cloning and building, you can point your MCP client at the hosted
Dooor OS MCP endpoint and pass your workspace API key in the `X-Api-Key`
header. The hosted server speaks the MCP **Streamable HTTP** transport in
stateless mode: it reads the key from each request, so your data stays scoped
to your own workspace even though one instance serves many clients.

> The key travels in `X-Api-Key` (not `Authorization`) because the hosted
> endpoint runs behind a front end that reserves the `Authorization` header for
> its own auth. `Authorization: Bearer dor_sk_...` is also accepted by the
> server itself, for setups that forward that header untouched.

**Claude Code:**

```bash
claude mcp add --transport http dooor-os https://mcp.dooor.ai/mcp \
  --header "X-Api-Key: dor_sk_your_key_here"
```

**Claude Desktop / `.mcp.json` (HTTP transport):**

```json
{
  "mcpServers": {
    "dooor-os": {
      "type": "http",
      "url": "https://mcp.dooor.ai/mcp",
      "headers": {
        "X-Api-Key": "dor_sk_your_key_here"
      }
    }
  }
}
```

Replace `dor_sk_your_key_here` with your workspace API key. Requests without a
valid key are rejected with `401`. No cloning, building or updating: you always
get the latest tools.

### Running the HTTP server yourself

```bash
npm install
npm run build
npm run start:http
```

The server listens on `0.0.0.0:$PORT` (default `8080`):

- `POST /mcp` - one JSON-RPC request per call; key read from `X-Api-Key` (or `Authorization: Bearer`).
- `GET /health` - returns `200 {"status":"ok"}` for health checks.

`GET`/`DELETE /mcp` return `405` because the server runs in stateless mode
(no long-lived session or server-initiated SSE stream). A `Dockerfile` is
included for container deploys (e.g. Cloud Run); it builds and runs
`dist/http.js`.

## Development

```bash
npm run dev    # tsc --watch
```
