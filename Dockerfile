FROM node:20-slim

# better-sqlite3 ships prebuilt binaries; build deps are only a fallback.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Application source
COPY src ./src
COPY public ./public

# Persistent SQLite data lives here (mounted as a volume in compose).
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/server.js"]
