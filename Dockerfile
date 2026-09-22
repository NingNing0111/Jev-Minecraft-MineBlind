# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS dependencies
# Build canvas from source on both amd64 and arm64 (no ARM prebuilt required).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ pkg-config libcairo2-dev libpango1.0-dev \
    libjpeg-dev libgif-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm_config_build_from_source=true npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libjpeg62-turbo \
    libgif7 librsvg2-2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json index.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
RUN mkdir -p /app/data/saves /app/data/knowledge && chown -R node:node /app/data
USER node
EXPOSE 3010 3011
CMD ["node", "index.js"]
