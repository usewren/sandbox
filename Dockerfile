FROM oven/bun:1
WORKDIR /app

# -------------------------------------------------------
# Install packages without local deps (cached before source copy)
# -------------------------------------------------------

COPY auth/package.json auth/bun.lock* /auth/
RUN cd /auth && bun install --frozen-lockfile

COPY db/package.json db/bun.lock* /db/
RUN cd /db && bun install --frozen-lockfile

# -------------------------------------------------------
# Copy all source (node_modules excluded via .dockerignore)
# -------------------------------------------------------

COPY auth/             /auth/
COPY db/               /db/
COPY docs/             /docs/
COPY adminui2/         /adminui2/
COPY marketing/        /marketing/
COPY sandbox/          /app/

# -------------------------------------------------------
# Install server packages — after source is present
# -------------------------------------------------------

COPY sandbox/package.json sandbox/bun.lock* ./
RUN bun install

# Copy plain-JS admin UI directly (no build step needed), served under /admin
RUN cp -r /adminui2 /app/public/admin

# Copy marketing site static files
RUN cp -r /marketing /app/public/marketing

# Build identifier reported by /health, e.g. --build-arg WREN_BUILD=$(git -C sandbox rev-parse --short HEAD)
ARG WREN_BUILD=dev
ENV WREN_BUILD=$WREN_BUILD

EXPOSE 4000

CMD ["bun", "run", "/app/index.ts"]
