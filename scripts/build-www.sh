#!/usr/bin/env bash
# 把网页文件复制到 www/（Capacitor 打包 App 时用；H5 部署也可以直接发布 www/ 目录）。
# 没有构建步骤：只是复制，不压缩、不转译。
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf www
mkdir -p www
cp -R index.html manifest.webmanifest sw.js icon.svg css js vendor mock-data www/
echo "www/ 已生成（$(find www -type f | wc -l | tr -d ' ') 个文件）"
