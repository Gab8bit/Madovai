#!/usr/bin/env bash
# Deploy sulla VM Docker, dal Mac:
#   DEPLOY_HOST=utente@IP-VM scripts/deploy.sh
# 1) costruisce l'immagine per l'architettura della VM (default linux/amd64),
# 2) la trasferisce via SSH (docker save | docker load: nessun registry, nessun sorgente sulla VM),
# 3) copia il docker-compose di produzione (e un .env di esempio se manca) in $DEPLOY_DIR,
# 4) riavvia il container e controlla /health.
# Usa una sola connessione SSH: senza chiave la password viene chiesta una volta sola, all'inizio
# (meglio ancora una chiave: vedi docs/DEPLOY.md).
set -euo pipefail

: "${DEPLOY_HOST:?Imposta DEPLOY_HOST, es. DEPLOY_HOST=utente@192.168.1.50}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/madovai-backend}"
PLATFORM="${PLATFORM:-linux/amd64}"
cd "$(dirname "$0")/.."
VERSION="$(node -p "require('./package.json').version")"

# One SSH connection for the whole deploy (ControlMaster): the password, if there is no key, is asked once, here.
CTL_DIR="$(mktemp -d /tmp/madovai-ssh.XXXXXX)"   # short path: sockets are limited to ~104 characters
SSH_OPTS=(-o ControlMaster=auto -o "ControlPath=$CTL_DIR/%C" -o ControlPersist=600)
cleanup() { ssh "${SSH_OPTS[@]}" -O exit "$DEPLOY_HOST" >/dev/null 2>&1 || true; rm -rf "$CTL_DIR"; }
trap cleanup EXIT
echo "→ connessione a $DEPLOY_HOST"
ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" true

# Dedicated tag per architecture: never overwrite the Mac's own (arm64) madovai-backend:latest used by ~/docker.
TAG="madovai-backend:${VERSION}-${PLATFORM#linux/}"
echo "→ build $TAG"
docker build --platform "$PLATFORM" -t "$TAG" .

echo "→ trasferimento dell'immagine su $DEPLOY_HOST (circa 100 MB compressi)"
docker save "$TAG" | gzip -1 | ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "gunzip | docker load && docker tag '$TAG' madovai-backend:latest"

echo "→ configurazione in $DEPLOY_DIR"
ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "mkdir -p '$DEPLOY_DIR/data' '$DEPLOY_DIR/secrets'"
scp -q "${SSH_OPTS[@]}" deploy/docker-compose.yml "$DEPLOY_HOST:$DEPLOY_DIR/docker-compose.yml"
ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "test -f '$DEPLOY_DIR/.env'" || scp -q "${SSH_OPTS[@]}" .env.example "$DEPLOY_HOST:$DEPLOY_DIR/.env"

echo "→ avvio"
ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "cd '$DEPLOY_DIR' && docker compose up -d && docker image prune -f >/dev/null"

# One remote session that retries by itself; asks the container (node is there, curl may not be on the VM).
echo "→ controllo /health"
if ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "cd '$DEPLOY_DIR' && sh -s" <<'REMOTE'
for i in $(seq 1 30); do
  if docker compose exec -T madovai-backend node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>r.ok?r.text():Promise.reject()).then(t=>console.log(t)).catch(()=>process.exit(1))" 2>/dev/null; then
    exit 0
  fi
  sleep 3
done
exit 1
REMOTE
then
  echo "Deploy completato (versione $VERSION)."
else
  echo "Il container non risponde su /health: guarda i log con  ssh $DEPLOY_HOST 'cd $DEPLOY_DIR && docker compose logs --tail 50'" >&2
  exit 1
fi
