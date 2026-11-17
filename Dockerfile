FROM oven/bun:1

WORKDIR /app

# Server dependencies (pg for Postgres). The React build in dist/ is committed,
# so no frontend toolchain is needed in the image.
COPY package.json bun.lock* ./
RUN bun install --production

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["bun", "run", "server.ts"]
