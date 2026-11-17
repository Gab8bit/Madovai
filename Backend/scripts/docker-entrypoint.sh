#!/bin/sh
# Container entrypoint (Docker and Proxmox LXC from the OCI image).
# Starts as root ONLY to make the data folder writable — a fresh Docker volume, a Proxmox mount point or a bind mount
# is usually owned by root — then drops to the unprivileged "node" user for the actual server.
set -e
DATA_DIR="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR" 2>/dev/null || chown node:node "$DATA_DIR" 2>/dev/null || true
  exec setpriv --reuid=node --regid=node --init-groups -- node /app/dist/server.js "$@"
fi
exec node /app/dist/server.js "$@"
