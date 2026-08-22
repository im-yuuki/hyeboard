FROM node:22-bookworm-slim AS build

WORKDIR /workspace
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm package

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/dist ./
RUN npm install --omit=dev && npm cache clean --force
USER node
EXPOSE 8787
ENTRYPOINT ["node", "dist/index.js"]
