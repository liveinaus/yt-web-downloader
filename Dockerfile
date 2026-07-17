# ── Stage 1: Build client + server (npm workspaces) ───────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
# python3/make/g++ required to compile argon2's native addon on musl/Alpine
RUN apk add --no-cache python3 make g++
COPY package*.json ./
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci
COPY client/ client/
COPY server/ server/
RUN npm run build && npm prune --omit=dev

# ── Stage 2: Production image ──────────────────────────────────────────────────
FROM node:22-alpine AS production
WORKDIR /app

ENV NODE_ENV=production \
    DATA_DIR=/app/data

# su-exec lets the entrypoint fix data-dir ownership as root, then drop to `node`
# python3 runs the yt-dlp zipapp; ffmpeg is needed for merging/transcoding
RUN apk add --no-cache su-exec python3 ffmpeg

# Latest yt-dlp release (zipapp) rather than the distro package, which goes stale
ADD https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp /usr/local/bin/yt-dlp
RUN chmod +x /usr/local/bin/yt-dlp

COPY --from=builder /app/node_modules       ./node_modules
COPY --from=builder /app/package.json       ./package.json
COPY --from=builder /app/server/package.json ./server/package.json
COPY --from=builder /app/server/dist        ./server/dist
COPY --from=builder /app/server/assets      ./server/assets
COPY --from=builder /app/client/dist        ./client/dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /app/data && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3033

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1:${PORT:-3033}/api/health || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
# Prefer IPv4 to avoid IPv6 routing issues in container environments
CMD ["node", "--dns-result-order=ipv4first", "server/dist/index.js"]
