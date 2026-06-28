# Dooor OS MCP server - remote (hosted) HTTP mode for Cloud Run.
FROM node:20-slim

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Build the TypeScript sources to dist/.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

ENV PORT=8080
EXPOSE 8080

# Stateless Streamable HTTP server; API key comes per-request via Authorization.
CMD ["node", "dist/http.js"]
