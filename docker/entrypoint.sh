#!/bin/sh
set -eu

DATA_DIR="${STELLARLIT_DATA_DIR:-/app/data}"

mkdir -p "$DATA_DIR/cache" "$DATA_DIR/media" "$DATA_DIR/starfields"

# 命名卷首次挂载时是空的,把镜像里的演示星空放进去一次。
if [ -d /app/seed/starfields ] && [ -z "$(find "$DATA_DIR/starfields" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
  cp -a /app/seed/starfields/. "$DATA_DIR/starfields/"
fi

# 绑定挂载的宿主目录通常不属于容器内的 node 用户;入口以 root 修正后降权运行。
chown -R node:node "$DATA_DIR"

exec gosu node "$@"
