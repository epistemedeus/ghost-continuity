#!/usr/bin/env bash
# Native Ghost 6.73.0 development install. Refuses without admission.
# Refuses when /tmp/ghost-continuity-sample already exists so a later run cannot replace the database.
# Development SQLite is not a production repair. The image path remains install/clean-install.sh.
set -euo pipefail

DIR='/tmp/ghost-continuity-sample'
URL='http://127.0.0.1:2368'

cat <<EOF
plane: installed-runtime
route: ghost-cli local development
ghost: 6.73.0
ghost_cli: 1.34.0
pnpm: 12.10.1
node_engines: ^22.23.1 || ^24.20.0
database: sqlite3 content/data/ghost-dev.db
scope: NODE_ENV=development on 127.0.0.1. This is not a production repair and it is not the Docker image.
documented_command: ghost install 6.73.0 --local --no-prompt --no-color --dir ${DIR} --url ${URL} --port 2368 --ip 127.0.0.1 --db sqlite3 --process local --pname ghost-continuity-sample --no-enable --verbose
path_note: put pnpm 12.10.1 ahead of any older pnpm. ghost-cli 1.34.0 supplies the ghost binary.
existing_dir_policy: refuse when ${DIR} already exists. Do not delete the database.
EOF

if [ "${GHOST_CONTINUITY_STAGE:-}" != "installed" ] || [ "${GHOST_CONTINUITY_ADMIT:-}" != "1" ]; then
  echo "refusing: set GHOST_CONTINUITY_STAGE=installed and GHOST_CONTINUITY_ADMIT=1. This command does not start Ghost."
  exit 3
fi

if [ -e "${DIR}" ]; then
  echo "refusing: ${DIR} already exists. This command does not reinstall or replace the database."
  exit 3
fi

GHOST_BIN="${GHOST_CONTINUITY_GHOST_BIN:-}"
if [ -z "${GHOST_BIN}" ] || [ ! -x "${GHOST_BIN}" ]; then
  echo "refusing: GHOST_CONTINUITY_GHOST_BIN is missing. This command does not download Ghost."
  exit 3
fi

exec "${GHOST_BIN}" install 6.73.0 --local --no-prompt --no-color \
  --dir "${DIR}" \
  --url "${URL}" \
  --port 2368 \
  --ip 127.0.0.1 \
  --db sqlite3 \
  --process local \
  --pname ghost-continuity-sample \
  --no-enable \
  --verbose
