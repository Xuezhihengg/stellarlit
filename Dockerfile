# syntax=docker/dockerfile:1.7
#
# StellarLit 生产镜像。
# 构建期不读取 .env:模型密钥、数据库口令都由运行时环境变量注入。
#
FROM node:24-bookworm-slim AS base
ARG PNPM_VERSION=12.11.2
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install -g "pnpm@${PNPM_VERSION}" \
 && pnpm config set store-dir /pnpm/store --global
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=stellarlit-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM base AS builder
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM node:24-bookworm-slim AS runner
RUN apt-get update \
 && apt-get install -y --no-install-recommends gosu \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    STELLARLIT_DATA_DIR=/app/data

# standalone 已包含运行时依赖;静态资源与 public 需单独拷贝
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# 仓库自带的演示星空。数据卷为空时由入口脚本灌入一次。
COPY --from=builder --chown=node:node /app/data/starfields ./seed/starfields
COPY docker/entrypoint.sh /usr/local/bin/stellarlit-entrypoint
RUN chmod +x /usr/local/bin/stellarlit-entrypoint \
 && mkdir -p /app/data \
 && chown node:node /app/data

EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/stellarlit-entrypoint"]
CMD ["node", "server.js"]
