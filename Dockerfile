FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=1455 \
    CODEX_DATA_DIR=/data \
    CODEX_ACCOUNTS_FILE=/data/accounts.json

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 1455

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:1455/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/index.js"]
