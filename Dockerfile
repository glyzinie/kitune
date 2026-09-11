FROM oven/bun:1.4.0 AS build
WORKDIR /app
COPY package.json bun.lock ./
# Keep downloads bounded in small Docker build environments.
RUN bun install --frozen-lockfile --network-concurrency 1
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN bun run check && bun run build

FROM oven/bun:1.4.0-slim
LABEL org.opencontainers.image.title="Kitune" \
    org.opencontainers.image.description="Passkey and Discord personal OIDC provider" \
    org.opencontainers.image.source="https://github.com/glyzinie/kitune"
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates gosu \
    && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile --network-concurrency 1
COPY --from=build /app/dist ./dist
COPY tsconfig.json ./
COPY src ./src
COPY scripts/entrypoint.sh /usr/local/bin/kitune-entrypoint
RUN chmod 755 /usr/local/bin/kitune-entrypoint
ENV NODE_ENV=production PORT=3000 CONFIG_PATH=/app/config.toml DATABASE_PATH=/data/kitune.sqlite
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/kitune-entrypoint"]
CMD ["bun", "src/server.ts"]
