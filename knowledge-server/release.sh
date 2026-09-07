#!/usr/bin/env bash
# 发布镜像到阿里云 ACR（方案 A：客户从 registry 拉镜像，不接触源码）。
#
#   ./release.sh <标签>          # 例：./release.sh 0.1.0
#   ./release.sh <完整镜像引用>   # 例：./release.sh registry.cn-shanghai.aliyuncs.com/aide-org/aide-knowledge:0.1.0
#
# 前置：docker login registry.cn-shanghai.aliyuncs.com 已完成；docker CLI 可用。
set -euo pipefail

cd "$(dirname "$0")"

REGISTRY="registry.cn-shanghai.aliyuncs.com"
REPO="${REGISTRY}/aide-org/aide-knowledge"

ARG="${1:-}"
[ -n "$ARG" ] || { echo "用法：./release.sh <标签>（例：./release.sh 0.1.0）" >&2; exit 1; }
# 传纯标签就补全仓库地址；传完整引用则原样使用
case "$ARG" in
  */*) IMG="$ARG" ;;
  *)   IMG="${REPO}:${ARG}" ;;
esac
VERSION="${ARG##*/}"

echo "==> [1/2] 构建 ${IMG}"
docker build -t "$IMG" .

echo "==> [2/2] 推送 ${IMG}"
docker push "$IMG"

echo
echo "已推送 ${IMG}。"
echo "记得同步 docker-compose.yml 里 knowledge 服务默认镜像的标签 → ${VERSION}"
echo "客户侧：下载 docker-compose.yml 与 .env.example，docker compose up -d 即可。"
