# Multi-stage production container for Jantra AI
# Build stage: compile TypeScript and native dependencies
FROM node:20-slim AS builder

WORKDIR /app

# Native compilation prerequisites for better-sqlite3
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --workspaces=false

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc -p tsconfig.json

# Prune dev dependencies so node_modules contains only runtime deps
RUN npm prune --omit=dev --workspaces=false

# Runtime stage: slim production image without build tools or tsx/typescript
FROM node:20-slim

WORKDIR /app

COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/package.json ./package.json
COPY --chown=node:node --from=builder /app/dist ./dist

# Create default data directory and ensure node user ownership
RUN mkdir -p /data/jantra && chown -R node:node /data/jantra /app

USER node

ENV NODE_ENV=production
ENV JANTRA_SERVER_PORT=4317
EXPOSE 4317

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.JANTRA_SERVER_PORT || 4317) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/server/remote.js"]
