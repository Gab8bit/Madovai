#!/usr/bin/env bash
# Builds Madovai for Android inside a throw-away Docker container: nothing is installed on the
# host (no JDK, no Android SDK, no ~/.gradle). The container is created, used and deleted.
#
#   ./build_apk.sh            debug APK                       → dist/Madovai-debug.apk
#   ./build_apk.sh release    signed release APK (+ tests, lint) → dist/Madovai-v<version>.apk
#   ./build_apk.sh test       unit tests + lint only
#
# Needs Docker (OrbStack / Docker Desktop). The container is linux/amd64 on purpose: the aapt2
# binary AGP downloads for Linux is x86_64-only (Apple Silicon runs it through Rosetta).
# Sources are mounted read-only and copied inside the container, so Gradle never writes
# build/, .gradle/ or local.properties into the repo.
#
# Release signing: app/build.gradle.kts reads the private keystore by absolute path. If that
# folder exists on this machine it is mounted read-only at the same path inside the container,
# so Gradle finds it unchanged (passwords are read by Gradle only, never printed). Without it
# the release APK is unsigned. Override the folder with MADOVAI_KEYSTORE_DIR.
#
# Env: KEEP_IMAGE=1 keeps the base image afterwards (by default it is removed again if this
# script had to pull it), OUT_DIR=… changes the output folder.
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-debug}"
IMAGE="eclipse-temurin:17-jdk-jammy"
NAME="madovai-android-build-$$"
OUT_DIR="${OUT_DIR:-$(pwd)/dist}"
KEYSTORE_DIR="${MADOVAI_KEYSTORE_DIR:-/Users/gabriele/Library/Mobile Documents/com~apple~CloudDocs/Documenti Importanti/Keystores Vari/Madovai Android}"
CMDLINE_TOOLS_ZIP="commandlinetools-linux-11076708_latest.zip"

case "$MODE" in
  debug) TASKS=(assembleDebug) ;;
  release) TASKS=(testDebugUnitTest lintRelease assembleRelease) ;;
  test) TASKS=(testDebugUnitTest lintRelease) ;;
  *) echo "uso: $0 [debug|release|test]" >&2; exit 2 ;;
esac

pulled=0
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker pull --platform linux/amd64 "$IMAGE"
  pulled=1
fi

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if [ "$pulled" = 1 ] && [ "${KEEP_IMAGE:-0}" != 1 ]; then docker image rm "$IMAGE" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

mounts=(--mount "type=bind,source=$(pwd),target=/src,readonly")
# The keystore is mounted only for release builds (debug/test never need it).
if [ "$MODE" = release ]; then
  if [ -d "$KEYSTORE_DIR" ]; then
    mounts+=(--mount "type=bind,source=$KEYSTORE_DIR,target=$KEYSTORE_DIR,readonly")
  else
    echo "Attenzione: cartella della keystore non trovata, l'APK di release non sarà firmato." >&2
  fi
fi

docker run -d --name "$NAME" --platform linux/amd64 "${mounts[@]}" "$IMAGE" sleep infinity >/dev/null

if [ "$MODE" = release ] && [ -d "$KEYSTORE_DIR" ] && ! docker exec "$NAME" test -r "$KEYSTORE_DIR/keystore.properties"; then
  # Typical on macOS when the folder is in iCloud Drive: the Docker VM isn't allowed to read it
  # (privacy permission for OrbStack/Docker) or the files are "solo su iCloud" (not downloaded).
  echo "Errore: il container non riesce a leggere la cartella della keystore." >&2
  echo "Scarica la cartella in locale (Finder → Scarica ora) e consenti a OrbStack/Docker l'accesso ai file di iCloud Drive" >&2
  echo "(Impostazioni di Sistema → Privacy e sicurezza), poi riprova." >&2
  exit 1
fi

docker exec -e CMDLINE_TOOLS_ZIP="$CMDLINE_TOOLS_ZIP" "$NAME" bash -euo pipefail -c '
  export DEBIAN_FRONTEND=noninteractive ANDROID_HOME=/opt/android-sdk
  apt-get update -qq && apt-get install -y -qq rsync unzip wget >/dev/null
  mkdir -p $ANDROID_HOME/cmdline-tools && cd /tmp
  wget -q "https://dl.google.com/android/repository/$CMDLINE_TOOLS_ZIP" -O clt.zip
  unzip -q clt.zip -d $ANDROID_HOME/cmdline-tools && mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest
  # `yes` gets SIGPIPE when sdkmanager stops reading: expected, not an error.
  (yes || true) | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --sdk_root=$ANDROID_HOME --licenses >/dev/null || true
  $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --sdk_root=$ANDROID_HOME "platforms;android-35" "build-tools;35.0.0" "build-tools;34.0.0" >/dev/null
'

docker exec "$NAME" bash -euo pipefail -c '
  mkdir -p /work && rsync -a --exclude build/ --exclude .gradle/ --exclude .kotlin/ --exclude local.properties --exclude dist/ /src/ /work/
  cd /work && echo "sdk.dir=/opt/android-sdk" > local.properties
  ./gradlew --no-daemon --console=plain '"${TASKS[*]}"'
'

mkdir -p "$OUT_DIR"
case "$MODE" in
  debug)
    docker cp "$NAME:/work/app/build/outputs/apk/debug/app-debug.apk" "$OUT_DIR/Madovai-debug.apk"
    echo "APK: $OUT_DIR/Madovai-debug.apk" ;;
  release)
    version=$(sed -n 's/.*versionName = "\(.*\)".*/\1/p' app/build.gradle.kts | head -1)
    apk=$(docker exec "$NAME" bash -c 'ls /work/app/build/outputs/apk/release/*.apk | head -1')
    docker exec "$NAME" /opt/android-sdk/build-tools/35.0.0/apksigner verify --print-certs "$apk" | grep -E "Signer #1 certificate (DN|SHA-256)" || echo "(APK non firmato)"
    docker cp "$NAME:$apk" "$OUT_DIR/Madovai-v$version.apk"
    echo "APK: $OUT_DIR/Madovai-v$version.apk" ;;
  test)
    echo "Test e lint completati." ;;
esac
