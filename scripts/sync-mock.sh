#!/usr/bin/env bash
# 把 ../api-doc/mock/*.json（演示数据源，唯一真源）复制到 mock-data/。
# axon-client 运行时从 mock-data/ 读取，这样仓库自包含，部署 / 打包都不依赖上级目录。
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="../api-doc/mock"
[ -d "$SRC" ] || { echo "找不到 $SRC（只在 Axon模拟盘 工作区里需要同步）"; exit 1; }
mkdir -p mock-data
cp "$SRC"/*.json mock-data/
echo "已同步：$(ls mock-data | tr '\n' ' ')"
