FROM oven/bun:1
WORKDIR /app

# -------------------------------------------------------
# Install packages without local deps (cached before source copy)
# -------------------------------------------------------

COPY auth/package.json auth/bun.lock* /auth/
RUN cd /auth && bun install --frozen-lockfile

COPY componentlibrary/package.json componentlibrary/bun.lock* /componentlibrary/
RUN cd /componentlibrary && bun install --frozen-lockfile

COPY db/package.json db/bun.lock* /db/
RUN cd /db && bun install --frozen-lockfile

# -------------------------------------------------------
# Copy all source (node_modules excluded via .dockerignore)
# -------------------------------------------------------

COPY auth/             /auth/
COPY componentlibrary/ /componentlibrary/
COPY db/               /db/
COPY docs/             /docs/
COPY adminui/          /adminui/
COPY adminui2/         /adminui2/
COPY marketing/        /marketing/
COPY sandbox/          /app/

# -------------------------------------------------------
# Install packages with local deps — after source is present
# so symlinks resolve correctly
# -------------------------------------------------------

COPY adminui/package.json adminui/bun.lock* /adminui/
RUN cd /adminui && bun install --frozen-lockfile

COPY sandbox/package.json sandbox/bun.lock* ./
RUN bun install

# -------------------------------------------------------
# Build legacy React admin UI served under /oldadmin
# -------------------------------------------------------

RUN cd /adminui && bun build ./index.html --outdir=/app/public/oldadmin --public-path=/oldadmin/

# Copy plain-JS admin UI directly (no build step needed), served under /admin
RUN cp -r /adminui2 /app/public/admin

# Copy marketing site static files
RUN cp -r /marketing /app/public/marketing

EXPOSE 4000

CMD ["bun", "run", "/app/index.ts"]
