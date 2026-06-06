FROM node:20-slim

# Build tools required for better-sqlite3 native compilation
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install root-level deps only — skip web/desktop/packages workspaces
COPY package*.json ./
RUN npm install --workspaces=false

# Copy source and TypeScript config
COPY src/ ./src/
COPY tsconfig.json ./

EXPOSE 4317

CMD ["node", "--import", "tsx", "src/server/remote.ts"]
