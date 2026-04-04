FROM oven/bun:1 AS base
WORKDIR /app

# Copy auth package first (local dependency)
COPY auth/ ../auth/
RUN cd ../auth && bun install --frozen-lockfile

# Install sandbox dependencies
COPY sandbox/package.json sandbox/bun.lock* ./
RUN bun install --frozen-lockfile

COPY sandbox/ .
COPY docs/ ../docs/

EXPOSE 4000
CMD ["bun", "run", "index.ts"]
