# Self-hosted build (Coolify): `next build`, then `next start` on port 3000.
FROM node:24-bookworm-slim AS build
ENV CI=1 NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--max-old-space-size=3072
WORKDIR /app
RUN corepack enable
COPY . .
# the app was written for Neon; the self-hosted build talks to a plain Postgres through deploy/neon-pg-shim
RUN if [ -f pnpm-workspace.yaml ]; then printf "\noverrides:\n  '@neondatabase/serverless': file:./deploy/neon-pg-shim\n" >> pnpm-workspace.yaml; \
    else node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json'));p.pnpm=Object.assign(p.pnpm||{},{overrides:Object.assign((p.pnpm||{}).overrides||{},{'@neondatabase/serverless':'file:./deploy/neon-pg-shim'})});fs.writeFileSync('package.json',JSON.stringify(p,null,2))"; fi
RUN pnpm install --frozen-lockfile=false
WORKDIR /app/apps/web
# the commit this image was built from, published so CI can tell the preview is up to date (.github/scripts/wait-for-preview.mjs)
ARG SOURCE_COMMIT
RUN mkdir -p public && printf "%s" "${SOURCE_COMMIT:-unknown}" > public/werft-commit.txt && pnpm build

FROM node:24-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app /app
WORKDIR /app/apps/web
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
# migrate this container's own database, then start (see deploy/start.mjs)
CMD ["node","/app/deploy/start.mjs"]
