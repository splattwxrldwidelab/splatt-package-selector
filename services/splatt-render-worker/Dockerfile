FROM node:20-bookworm-slim

# Install FFmpeg and ffprobe
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy worker and assets
COPY worker.mjs ./worker.mjs
COPY assets ./assets

# Health check (optional but recommended for continuous services)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD ps aux | grep -v grep | grep "node worker.mjs" || exit 1

CMD ["node", "worker.mjs"]
