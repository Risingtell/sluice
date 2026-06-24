# Sluice resource server — always-on LIVE proof feed.
# Run the autonomous agent / scripts/volume.sh separately against this server's public URL.
FROM node:24-slim

WORKDIR /app

# Install deps first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# App source (keys/ and .env are NOT copied — provide secrets via env vars / mounted files).
COPY tsconfig.json ./
COPY shared ./shared
COPY server ./server
COPY scripts ./scripts

# Durable proof feed lives on a mounted volume; default still works without one.
ENV NODE_ENV=production
ENV PORT=4021
ENV SNAPSHOT_PATH=/data/impact.json
RUN mkdir -p /data

EXPOSE 4021

# tsx is a runtime dep used to run the TS server directly (no build step).
RUN npm install -g tsx@4.19.2

CMD ["tsx", "server/src/index.ts"]
