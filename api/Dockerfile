# ─────────────────────────────────────────────────────────────────────────────
# Multi-arch build for AppCloud API (Fastify, Node 20 ESM)
#
# BUILDPLATFORM  = the machine running `docker build` (arm64 on Mac M-series)
# TARGETPLATFORM = the platform the final image will run on (amd64 on AKS)
#
# Local dev (Mac):
#   docker build -t appcloud-api:latest ./api
#
# CI / AKS image (explicit target):
#   docker build --platform linux/amd64 -t appcloud-api:latest ./api
#
# Both architectures in one push (requires docker buildx):
#   docker buildx build \
#     --platform linux/amd64,linux/arm64 \
#     -t <registry>/appcloud-api:latest \
#     --push ./api
#
# Minikube (Apple Silicon — keeps arm64 locally):
#   docker build --platform linux/arm64 -t appcloud-api:latest ./api
#   minikube image load appcloud-api:latest --profile=appcloud
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: install production dependencies ──────────────────────────────────
# Runs on the BUILD machine — no emulation overhead for npm ci.
FROM --platform=$BUILDPLATFORM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --prefer-offline

# ── Stage 2: production runner ────────────────────────────────────────────────
# Uses TARGETPLATFORM so the final image matches the cluster architecture.
# On AKS this resolves to linux/amd64; on your Mac it stays linux/arm64.
FROM --platform=$TARGETPLATFORM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Copy only production node_modules from the deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source (ESM — no build step needed for Fastify)
COPY src/ ./src/
COPY package*.json ./

EXPOSE 3000

# FIX: --watch is a dev-only flag that restarts the process on file changes.
# It must not run in production — use plain `node` instead.
CMD ["node", "src/server.js"]