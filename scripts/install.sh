#!/usr/bin/env bash
# Installs mu from GitHub Releases — no npm, no Bun. Downloads the platform's
# release archive, verifies it against the published SHA256SUMS, and unpacks it
# into ~/.mu (executable at ~/.mu/bin/mu).
#
# Usage: curl -fsSL https://raw.githubusercontent.com/Spandan7724/mu/main/scripts/install.sh | bash

set -euo pipefail

REPO="Spandan7724/mu"
MU_ROOT="${HOME}/.mu"
INSTALL_DIR="${MU_ROOT}/bin"
BIN_NAME="mu"
RECEIPT_NAME=".mu-install.json"
# Replaced wholesale on install; everything else in ~/.mu is user state.
OWNED_ENTRIES="mu-path licenses mu-package.json"

die() {
  echo "error: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but was not found on PATH"
}

need curl
need tar

os="$(uname -s)"
arch="$(uname -m)"
target=""

case "$os" in
  Linux)
    case "$arch" in
      x86_64 | amd64) target="linux-x64" ;;
    esac
    ;;
  Darwin)
    case "$arch" in
      arm64) target="darwin-arm64" ;;
    esac
    ;;
esac

if [ -z "$target" ]; then
  die "unsupported platform (${os} ${arch}). Download a build manually from https://github.com/${REPO}/releases/latest"
fi

asset="mu-${target}.tar.gz"

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  die "need sha256sum or shasum to verify the download"
fi

latest_url=$(curl -fsSL -o /dev/null -w '%{url_effective}' \
  "https://github.com/${REPO}/releases/latest") ||
  die "could not resolve the latest release (does ${REPO} have any releases?)"
tag="${latest_url##*/}"
version="${tag#v}"

echo "Installing mu ${version} (${target})..."

mkdir -p "$INSTALL_DIR"

# Staged inside ~/.mu so the final moves are same-filesystem renames.
staging=$(mktemp -d "${MU_ROOT}/.install.XXXXXX")
trap 'rm -rf "$staging"' EXIT

tmp_sums="${staging}/SHA256SUMS"
archive_path="${staging}/${asset}"
extract_dir="${staging}/extract"

curl -fsSL --retry 3 --connect-timeout 10 \
  "https://github.com/${REPO}/releases/download/${tag}/SHA256SUMS" \
  -o "$tmp_sums" || die "could not download SHA256SUMS for ${tag}"

expected=$(awk -v f="$asset" '{name=$2; sub(/^\*/, "", name); if (name == f) print $1}' "$tmp_sums")
[ -n "$expected" ] || die "SHA256SUMS does not list a digest for ${asset}"

# A wall-clock cap would fail a slow but healthy link; abort only on a stall.
curl -fsSL --retry 3 --connect-timeout 10 --speed-limit 1024 --speed-time 60 -C - \
  "https://github.com/${REPO}/releases/download/${tag}/${asset}" \
  -o "$archive_path" || die "could not download ${asset}"

actual=$(sha256 "$archive_path")
if [ "$actual" != "$expected" ]; then
  die "checksum mismatch for ${asset}: expected ${expected}, got ${actual}"
fi

mkdir -p "$extract_dir"
tar -xzf "$archive_path" -C "$extract_dir" || die "could not extract ${asset}"

staged="${extract_dir}/mu-${target}"
staged_binary="${staged}/bin/${BIN_NAME}"
[ -f "$staged_binary" ] || die "${asset} did not contain mu-${target}/bin/${BIN_NAME}"
chmod +x "$staged_binary"
if [ -f "${staged}/mu-path/rg" ]; then
  chmod +x "${staged}/mu-path/rg"
fi

for entry in $OWNED_ENTRIES; do
  if [ -e "${staged}/${entry}" ]; then
    rm -rf "${MU_ROOT:?}/${entry}"
    mv "${staged}/${entry}" "${MU_ROOT}/${entry}"
  fi
done

mv "$staged_binary" "${INSTALL_DIR}/${BIN_NAME}"

cat >"${INSTALL_DIR}/${RECEIPT_NAME}" <<EOF
{"method":"github-release","target":"${target}"}
EOF

echo "Installed mu ${version} to ${INSTALL_DIR}/${BIN_NAME}"

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo
    echo "${INSTALL_DIR} is not on your PATH. Add it, e.g.:"
    case "${SHELL:-}" in
      */fish) echo "  fish_add_path ${INSTALL_DIR}   # in fish, or add to ~/.config/fish/config.fish" ;;
      */zsh) echo "  echo 'export PATH=\"${INSTALL_DIR}:\$PATH\"' >> ~/.zshrc" ;;
      *) echo "  echo 'export PATH=\"${INSTALL_DIR}:\$PATH\"' >> ~/.bashrc" ;;
    esac
    echo "then restart your shell."
    ;;
esac

echo
echo "Run '${BIN_NAME} --version' to verify. 'mu self update' keeps this install current."
