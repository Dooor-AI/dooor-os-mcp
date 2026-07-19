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
* `data_products`: discover which data products and capabilities are enabled
  for the active workspace.
* `data_*`: business questions over connected operational sources such as field
  service, finance, issues and client records. Use `data_ask` first for most
  natural-language questions.
* `data_connections`, `data_connection_capabilities` and
  `data_connection_read`: discover and read allowlisted entities from live
  operational connections through the Dooor read-only proxy.
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

Clone and install:

```bash
git clone https://github.com/Dooor-AI/dooor-os-mcp.git
cd dooor-os-mcp
npm install
```

`npm start` compiles before starting, so the local MCP remains usable after a
fresh clone or cleanup without depending on an old `dist/` directory.

Then register it with your MCP client, passing your workspace API key via the
`DOOOR_API_KEY` environment variable. Example MCP client config:

```json
{
  "mcpServers": {
    "dooor-os": {
      "command": "npm",
      "args": ["--prefix", "/absolute/path/to/dooor-os-mcp", "start"],
      "env": {
        "DOOOR_API_KEY": "dor_sk_your_key_here"
      }
    }
  }
}
```

Optional env:

- `DOOOR_BASE_URL` - override the API base URL (default
  `https://api.os.dooor.ai/v1`).

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

### Error handling and rate limits

The hosted server does not return upstream response bodies, stack traces or
internal exception messages. Public failures include a server-generated
correlation ID, also returned in the `X-Correlation-Id` response header. Share
that ID with the operator when troubleshooting. Caller-provided request IDs are
not trusted or echoed.

The HTTP process keeps a best-effort in-memory limit of 120 requests per minute
for each hashed API key, plus a process-local concurrency guard. It is only a
defense for that MCP instance. The Dooor backend is the authoritative source
for global quotas and rate limits across every MCP instance. The MCP server
does not identify or rate-limit clients by source IP because reverse proxies
can make unrelated clients share one address.

## Building an app with connected data

Use MCP while developing to discover what the workspace exposes. A running app
does not embed an MCP client and does not call connected systems directly. Its
backend calls the Dooor REST API with `Authorization: Bearer <DOOOR_API_KEY>`.

For replicated or curated data, use `/data/*` and `/data/lake/*`. For a live
operational connection, use this sequence:

1. `GET /workspaces/{ws}/data-sources`
2. `GET /workspaces/{ws}/data-sources/{sourceId}/capabilities`
3. `POST /workspaces/{ws}/data-sources/{sourceId}/operation`

The operation body contains an advertised `entity`, `operation` (`list` or
`get`) and optional `id`, `filter`, `cursor` and `maxRows`. Dooor keeps source
credentials in its secret store, enforces configured fixed filters and returns
only allowlisted read data.

Create a dedicated key for each deployed app with only
`data-sources:read` and `data-sources:query`, restricted to the required
`dataSourceIds`. Store it only in the app backend's environment. Never reuse a
person's MCP key or expose the key to browser code. Call `integration_guide` for
a complete TypeScript client.

## Development

```bash
npm run dev    # tsc --watch
npm run typecheck
npm test
```
