#!/usr/bin/env bash
# Disposable Ghost 6.73 development container. Refuses unless admission is set.
# The image digest is the linux/amd64 manifest from the official library/ghost:6.73.0 index.
# This sample does not pull the image during acceptance.
set -euo pipefail

IMAGE='ghost@sha256:3656324ad804308b9ef39571b15b41465cdee64f6a78d1807719b5ea379688fd'
NAME='ghost-continuity-sample'
PORT='127.0.0.1:2368:2368'

cat <<EOF
plane: installed-runtime
image: ${IMAGE}
container_name: ${NAME}
documented_command: docker run -d --name ${NAME} -e NODE_ENV=development -e url=http://127.0.0.1:2368 -p ${PORT} ${IMAGE}
stop_owned_only: docker rm -f ${NAME}
database: official image development mode. Production mode requires MySQL 8 and is not this disposable sample.
EOF

if [ "${GHOST_CONTINUITY_STAGE:-}" != "installed" ] || [ "${GHOST_CONTINUITY_ADMIT:-}" != "1" ]; then
  echo "refusing: set GHOST_CONTINUITY_STAGE=installed and GHOST_CONTINUITY_ADMIT=1. This command does not start Ghost."
  exit 3
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "refusing: docker is not installed on this host"
  exit 3
fi

docker rm -f "${NAME}" >/dev/null 2>&1 || true
exec docker run -d --name "${NAME}" \
  -e NODE_ENV=development \
  -e url=http://127.0.0.1:2368 \
  -p "${PORT}" \
  "${IMAGE}"
