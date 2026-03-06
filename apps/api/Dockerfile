FROM node:22-alpine

RUN npm install -g pnpm

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/

RUN pnpm install

COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

EXPOSE 3000

CMD ["pnpm", "--filter", "@project/api", "dev"]
