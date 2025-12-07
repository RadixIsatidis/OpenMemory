# ===== BUILD STAGE =====
FROM node:24-alpine AS builder

# Accept proxy settings as build arguments
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY

WORKDIR /app

# Install system dependencies required for native module compilation,
# plus curl and bash (needed to run the Bun installation script)
# Use proxy settings directly in RUN command
RUN HTTP_PROXY=${HTTP_PROXY} \
    HTTPS_PROXY=${HTTPS_PROXY} \
    http_proxy=${HTTP_PROXY} \
    https_proxy=${HTTPS_PROXY} \
    NO_PROXY=${NO_PROXY} \
    no_proxy=${NO_PROXY} \
    apk add --no-cache python3 make g++ curl bash

# Install Bun globally and relocate it to a shared, persistent location
RUN HTTP_PROXY=${HTTP_PROXY} \
    HTTPS_PROXY=${HTTPS_PROXY} \
    http_proxy=${HTTP_PROXY} \
    https_proxy=${HTTPS_PROXY} \
    NO_PROXY=${NO_PROXY} \
    no_proxy=${NO_PROXY} \
    curl -fsSL https://bun.sh/install | bash \
 && mv /root/.bun /opt/bun \
 && ln -s /opt/bun/bin/bun /usr/local/bin/bun

# Ensure Bun is available in PATH for subsequent commands
ENV PATH="/opt/bun/bin:${PATH}"

# Copy package manifests to install dependencies
COPY package*.json ./

# Install all dependencies (including devDependencies) using Bun
# --frozen-lockfile ensures reproducible builds
# --concurrent-scripts and --network-concurrency optimize install speed
RUN HTTP_PROXY=${HTTP_PROXY} \
    HTTPS_PROXY=${HTTPS_PROXY} \
    http_proxy=${HTTP_PROXY} \
    https_proxy=${HTTPS_PROXY} \
    NO_PROXY=${NO_PROXY} \
    no_proxy=${NO_PROXY} \
    bun install --concurrent-scripts=10 --network-concurrency=96

# Copy source code and build the application
COPY src/ ./src/
COPY tsconfig.json ./
COPY models.yml ./
# Increase Node.js memory limit for TypeScript compilation
RUN NODE_OPTIONS="--max-old-space-size=16384" bun run build

# Remove devDependencies to reduce image size
# (Removing all the devDependencies that we dont need in the final build)
RUN npm prune --omit=dev


# ===== PRODUCTION STAGE =====
FROM node:24-alpine AS production

WORKDIR /app

# Install timezone data for proper TZ support
RUN apk add --no-cache tzdata

# Create a dedicated non-root user for security
RUN addgroup -g 1001 -S appgroup \
 && adduser -u 1001 -S appuser -G appgroup

# Copy only production artifacts from the builder stage
COPY --from=builder /app/node_modules ./node_modules/
COPY --from=builder /app/dist ./dist/
COPY package.json ./
COPY models.yml ./

# Set production environment for Node.js
ENV NODE_ENV=production

# Create a directory for persistent data and secure file permissions
RUN mkdir -p /data \
 && chown -R appuser:appgroup /data /app \
 && chmod -R go-w /app

# Switch to non-root user
USER appuser

# Expose the application port
EXPOSE 8080

# Define a lightweight health check that verifies the /health endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8080/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Start the application directly with Node (npm not required in runtime)
ENTRYPOINT ["node", "dist/server/index.js"]
