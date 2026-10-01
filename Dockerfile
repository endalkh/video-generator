# syntax=docker/dockerfile:1

# ---------- build: compile TypeScript, generate the Prisma client, build Tailwind CSS ----------
FROM node:24.21.0-trixie-slim AS build
WORKDIR /app
# No DATABASE_URL at build time: .env is excluded by .dockerignore (keeps secrets out of image layers).
# The app gets it at runtime from docker-compose.
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build

# ---------- runtime: production deps + ffmpeg ----------
FROM node:24.21.0-trixie-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates openssl tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5178 \
    MEDIA_ROOT=/app/output
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# Skip our postinstall (`prisma generate`): the client is already compiled into dist/ by the build stage.
# But do run Prisma's own install scripts, which download the schema engine that `migrate deploy` needs
# (as root, at build time, because the runtime user can't write to node_modules).
RUN npm ci --omit=dev --ignore-scripts \
 && npm rebuild prisma @prisma/engines \
 && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY docker/app-entrypoint.sh /usr/local/bin/app-entrypoint.sh
RUN chmod +x /usr/local/bin/app-entrypoint.sh \
 && mkdir -p /app/output && chown -R node:node /app/output
USER node
EXPOSE 5178
VOLUME ["/app/output"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/config').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "app-entrypoint.sh"]
CMD ["node", "dist/main.js"]
