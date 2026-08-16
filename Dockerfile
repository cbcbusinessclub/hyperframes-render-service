# HyperFrames Render Service — production image for Render.com (or any Docker host)
# Mirrors the rendering environment of the official HyperFrames Dockerfile.test:
# system Chromium + pinned chrome-headless-shell + FFmpeg + Noto fonts.

FROM node:22-bookworm-slim

# ── System dependencies (same set the HyperFrames producer uses) ─────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    unzip \
    ffmpeg \
    chromium \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libcups2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libxshmfence1 \
    libgtk-3-0 \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-noto-cjk \
    fonts-noto-core \
    fonts-noto-extra \
    fonts-noto-ui-core \
    fonts-freefont-ttf \
    fonts-dejavu-core \
    fontconfig \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean \
    && fc-cache -fv

# Use system Chromium; skip puppeteer's own download
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV CONTAINER=true
ENV HYPERFRAMES_TELEMETRY=0

# chrome-headless-shell for deterministic BeginFrame rendering
# (pinned version, same as the official HyperFrames test image)
RUN npx --yes @puppeteer/browsers install chrome-headless-shell@148.0.7778.167 \
      --path /root/.cache/puppeteer \
    && echo "chrome-headless-shell installed"

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js ./
COPY templates ./templates

# Render.com injects PORT; default for local runs
ENV PORT=10000
ENV DATA_DIR=/data
EXPOSE 10000

CMD ["node", "server.js"]
