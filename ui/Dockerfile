# ─────────────────────────────────────────────────────────────────────────────
# Multi-arch build for AppCloud UI
#
# BUILDPLATFORM  = the machine running `docker build` (arm64 on Mac M-series)
# TARGETPLATFORM = the platform the final image will run on (amd64 on AKS)
#
# The deps + builder stages run on BUILDPLATFORM (fast, no emulation).
# The runner stage targets TARGETPLATFORM so the image runs on AKS nodes.
#
# Local dev (Mac):
#   docker build -t appcloud-ui:latest ./ui
#
# CI / AKS image (explicit target):
#   docker build --platform linux/amd64 -t appcloud-ui:latest ./ui
#
# Both architectures in one push (requires docker buildx):
#   docker buildx build \
#     --platform linux/amd64,linux/arm64 \
#     -t <registry>/appcloud-ui:latest \
#     --push ./ui
#
# Minikube (Apple Silicon — keeps arm64 locally):
#   docker build --platform linux/arm64 -t appcloud-ui:latest ./ui
#   minikube image load appcloud-ui:latest --profile=appcloud
# ─────────────────────────────────────────────────────────────────────────────
 
# ── Stage 1: install dependencies ────────────────────────────────────────────
# Runs on the BUILD machine — no emulation overhead for npm install.
FROM --platform=$BUILDPLATFORM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --prefer-offline
 
# ── Stage 2: build the Next.js app ───────────────────────────────────────────
# Also runs on the BUILD machine — Next.js compilation is pure JS, so the
# output is architecture-independent and can be copied into any target image.
FROM --platform=$BUILDPLATFORM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
 
# ── Stage 3: production runner ───────────────────────────────────────────────
# Uses TARGETPLATFORM so the final layer matches whatever the cluster expects.
# On AKS this resolves to linux/amd64; on your Mac it stays linux/arm64.
FROM --platform=$TARGETPLATFORM node:20-alpine AS runner
WORKDIR /app
 
ENV NODE_ENV=production
ENV PORT=4000
ENV HOSTNAME=0.0.0.0
 
# Copy only the standalone output — smallest possible runtime image
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
 
# public/ is optional in standalone mode but keep it for static assets
RUN mkdir -p ./public
 
EXPOSE 4000
CMD ["node", "server.js"]
