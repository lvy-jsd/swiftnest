FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /source
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm exec tsc -b packages/relay
RUN pnpm --filter @swiftnest/relay deploy --prod /out

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build --chown=node:node /out .
USER node
ENV SWIFTNEST_RELAY_HOST=0.0.0.0
EXPOSE 8787
CMD ["node", "dist/cli.js"]
