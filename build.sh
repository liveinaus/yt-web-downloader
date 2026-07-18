#!/usr/bin/env bash
# Builds the production image with the git tag baked in as the UI version.
set -e
cd "$(dirname "${BASH_SOURCE[0]}")"

IMAGE=${IMAGE:-liveinaus/yt-web-downloader:latest}

# e.g. "dev-v0.1.0-3", "dev-v0.1.0-3-2-gabc1234" (2 commits past the tag), or
# "...-dirty" when the working tree has uncommitted changes
VERSION=$(git describe --tags --always --dirty 2>/dev/null || echo dev)

docker build --build-arg APP_VERSION="$VERSION" -t "$IMAGE" .

echo ""
echo "Built $IMAGE ($VERSION)"
echo "Deploy with: docker compose up -d"
