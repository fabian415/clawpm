#!/usr/bin/env bash
# Build 自訂 OpenClaw image（含 Python 套件）
# 用法：在 clawpm 根目錄執行  bash docker/build.sh

set -e

IMAGE_TAG="clawpm-openclaw:2026.6.8-py"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Building $IMAGE_TAG ..."
docker build -t "$IMAGE_TAG" "$SCRIPT_DIR"

echo ""
echo "Build 完成。請在 .env 加入或更新以下設定："
echo "  OPENCLAW_IMAGE=$IMAGE_TAG"
