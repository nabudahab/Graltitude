#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if command -v node >/dev/null && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  exec node apps/desktop/server.mjs "$@"
fi
version=v24.22.3
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) target=darwin-arm64; checksum=ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd ;;
  Darwin/x86_64) target=darwin-x64; checksum=977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7 ;;
  Linux/aarch64|Linux/arm64) target=linux-arm64; checksum=261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8 ;;
  Linux/x86_64) target=linux-x64; checksum=061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2 ;;
  *) echo "Open Graltitude.html to use ride files on this computer."; exit 1 ;;
esac
umask 077
cache="${XDG_CACHE_HOME:-$HOME/.cache}/graltitude/$version/$target"
if [ ! -x "$cache/node" ]; then
  mkdir -p "$cache"
  temp=$(mktemp -d "$cache/download.XXXXXXXX")
  trap 'rm -rf "$temp"' EXIT
  package="node-$version-$target"
  echo "Downloading the Graltitude runtime for this computer…"
  curl --fail --location --show-error --silent "https://nodejs.org/dist/$version/$package.tar.gz" -o "$temp/node.tar.gz"
  if command -v sha256sum >/dev/null; then
    hash=$(sha256sum "$temp/node.tar.gz")
  else
    hash=$(shasum -a 256 "$temp/node.tar.gz")
  fi
  if [ "${hash%% *}" != "$checksum" ]; then echo "Runtime download failed verification."; exit 1; fi
  tar -xzOf "$temp/node.tar.gz" "$package/bin/node" > "$temp/node"
  chmod 700 "$temp/node"
  mv "$temp/node" "$cache/node"
  rm -rf "$temp"
  trap - EXIT
fi
exec "$cache/node" apps/desktop/server.mjs "$@"
