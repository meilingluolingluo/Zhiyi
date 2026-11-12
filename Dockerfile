FROM node:22-alpine

WORKDIR /app

COPY package.json tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts

RUN mkdir -p /app/data \
    && npm install \
    && npm run build \
    && npm prune --omit=dev

ENV PORT=8787 \
    DATABASE_URL=/app/data/memory.db \
    MOCK_UPSTREAM=true \
    MULTICA_BASE_URL= \
    DEFAULT_MODEL=mock-gpt \
    MEMORY_ENABLED=true \
    MEMORY_AUTO_EXTRACT=true

EXPOSE 8787

CMD ["node", "dist/src/server.js"]
