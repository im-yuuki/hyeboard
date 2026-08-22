FROM node:22-bookworm-slim AS build

WORKDIR /workspace
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @hyeboard/automation-worker build
RUN mkdir -p /out/dist \
  && cp apps/automation-worker/dist/cli.cjs /out/dist/cli.cjs \
  && node -e "const fs=require('fs'); const p=require('./apps/automation-worker/package.json'); fs.writeFileSync('/out/package.json', JSON.stringify({name:'hyeboard-automation-worker', private:true, type:p.type, dependencies:{redis:p.dependencies.redis, 'puppeteer-core':p.dependencies['puppeteer-core']}}, null, 2));"

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/dist ./dist
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force
USER node
EXPOSE 8080
ENTRYPOINT ["node", "dist/cli.cjs"]
