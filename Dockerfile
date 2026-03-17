FROM node:24-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    g++ \
    libsodium-dev \
    libzmq3-dev \
    make \
    pkg-config \
    python3 \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY config ./config
COPY src ./src

RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ARG FFMPEG_RELEASE_TAG="autobuild-2026-03-17-13-11"
ARG FFMPEG_ASSET="ffmpeg-n8.0.1-76-gfa4ee7ab3c-linux64-gpl-8.0.tar.xz"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    dumb-init \
    libsodium23 \
    libzmq5 \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp
RUN curl -fsSL -o "$FFMPEG_ASSET" \
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_RELEASE_TAG}/${FFMPEG_ASSET}" \
  && tar -xf "$FFMPEG_ASSET" \
  && install -m 0755 ./*/bin/ffmpeg /usr/local/bin/ffmpeg \
  && install -m 0755 ./*/bin/ffprobe /usr/local/bin/ffprobe \
  && rm -rf /tmp/*

WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/config ./config

RUN useradd --system --uid 10001 --create-home appuser \
  && chown -R appuser:appuser /app

USER appuser

ENV NODE_ENV=production
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node", "build/healthcheck.js"]
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "build/index.js"]
