FROM node:22-alpine

RUN npm install -g pnpm

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/

RUN pnpm install

COPY packages/shared ./packages/shared
COPY apps/web ./apps/web

EXPOSE 5173

CMD ["pnpm", "--filter", "@project/web", "dev", "--host"]
