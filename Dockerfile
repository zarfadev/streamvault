# ── Stage base: sistema operativo + FFmpeg ────────────────────────────────────
FROM node:20-alpine AS base

RUN apk add --no-cache \
    ffmpeg \
    python3 \
    make \
    g++ \
    wget \
    curl \
    unzip \
    gcompat \
    libstdc++ && \
    DENO_VER=$(curl -s https://api.github.com/repos/denoland/deno/releases/latest | python3 -c "import sys,json; print(json.load(sys.stdin)['tag_name'][1:])") && \
    curl -fsSL "https://github.com/denoland/deno/releases/download/v${DENO_VER}/deno-x86_64-unknown-linux-gnu.zip" -o /tmp/deno.zip && \
    unzip /tmp/deno.zip -d /usr/local/bin && \
    rm /tmp/deno.zip && \
    deno --version

WORKDIR /app

# ── Stage development: todas las deps + código montado por volumen ────────────
FROM base AS development

COPY package*.json ./
RUN npm install

COPY . .

RUN mkdir -p uploads videos logs && \
    chmod 755 uploads videos logs

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]

# ── Stage production: solo deps de producción, imagen más pequeña ─────────────
FROM base AS production

COPY package*.json ./
# --omit=dev: no instala devDependencies (reduce imagen ~40%)
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN mkdir -p uploads videos logs && \
    chown -R node:node uploads videos logs

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -qO- http://localhost:3000/api/health || exit 1

# Run as non-root for security — node user is built into node:alpine
USER node

CMD ["node", "server.js"]
