#!/usr/bin/env bash
# 发布镜像到阿里云 ACR（方案 A：客户从 registry 拉镜像，不接触源码）。
#
#   ./release.sh <版本号>          # 例：./release.sh 0.5.0
#   ./release.sh <完整镜像引用>   # 例：./release.sh crpi-xxx.cn-shanghai.personal.cr.aliyuncs.com/aide-org/aide-knowledge:0.5.0
#
# 每次发布推**两个**标签，这是「用户侧那条升级命令一辈子不变」的全部机制：
#
#   :<版本号>   不可变。用于钉住某一版、以及回滚（.env 里写死它）。
#   :stable     移动标签，每次都指向最新那版。交付的 compose 跟的是它。
#
# 于是用户侧永远是这一条（不随版本变）：
#   docker compose pull knowledge && docker compose up -d knowledge
#
# 前置：docker login <crpi 域名> 已完成；docker CLI 可用。
#   ⚠️ 域名要用 ACR 个人版「访问凭证」页给的 crpi- 专属实例域名（2024-09 后新建的个人版
#   实例不再认 registry.cn-*.aliyuncs.com 旧域名，会报 insufficient_scope）。
set -euo pipefail

cd "$(dirname "$0")"

REGISTRY="registry.example.com"
REPO="${REGISTRY}/aide-org/aide-knowledge"
STABLE="${REPO}:stable"

ARG="${1:-}"
[ -n "$ARG" ] || { echo "用法：./release.sh <版本号>（例：./release.sh 0.5.0）" >&2; exit 1; }
# 传纯标签就补全仓库地址；传完整引用则原样使用
case "$ARG" in
  */*) IMG="$ARG" ;;
  *)   IMG="${REPO}:${ARG}" ;;
esac
VERSION="${ARG##*/}"

# 版本号注入镜像（客户端靠它判断「服务端够不够新」并提示用户升级）。
# ⚠️ 不带它构建出来的是 `dev`，客户端见了不提示——那正是本地 up -d --build 的形态。
echo "==> [1/3] 构建 ${IMG}（KB_VERSION=${VERSION}）"
docker build --build-arg "KB_VERSION=${VERSION}" -t "$IMG" .

echo "==> [2/3] 推送 ${IMG}（版本号标签，不可变；回滚靠钉它）"
docker push "$IMG"

echo "==> [3/3] 打并推送移动标签 ${STABLE}"
docker tag "$IMG" "$STABLE"
docker push "$STABLE"

echo
echo "已推送："
echo "  ${IMG}"
echo "  ${STABLE}"
echo
echo "交付件（docker-compose.yml / .env.example）跟的是 :stable，**不需要随版本改**。"
echo "已部署的用户会在知识库面板上看到「有新版本 ${VERSION}」，并拿到一条带版本号的升级命令"
echo "（服务端查发布渠道的标签列表，缓存 30 分钟）。"
