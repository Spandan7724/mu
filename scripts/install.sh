#!/usr/bin/env bash
# Installs mu directly from GitHub Releases — no npm, no Bun. Downloads the
# platform's single-file executable, verifies it against the release's
# published SHA256SUMS, and installs it to ~/.mu/bin/mu.
#
# Usage: curl -fsSL https://raw.githubusercontent.com/Spandan7724/mu/main/scripts/install.sh | bash

set -euo pipefail

REPO="Spandan7724/mu"
INSTALL_DIR="${HOME}/.mu/bin"
BIN_NAME="mu"
RECEIPT_NAME=".mu-install.json"

die() {
  echo "error: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but was not found on PATH"
}

need curl

os="$(uname -s)"
arch="$(uname -m)"
target=""
asset=""

case "$os" in
  Linux)
    case "$arch" in
      x86_64 | amd64) target="linux-x64"; asset="mu-linux-x64" ;;
    esac
    ;;
  Darwin)
    case "$arch" in
      arm64) target="darwin-arm64"; asset="mu-darwin-arm64" ;;
    esac
    ;;
esac

if [ -z "$target" ]; then
  die "unsupported platform (${os} ${arch}). Download a build manually from https://github.com/${REPO}/releases/latest"
fi

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

tmp_sums=$(mktemp)
download_path="${INSTALL_DIR}/.${BIN_NAME}.download.$$"
trap 'rm -f "$tmp_sums" "$download_path"' EXIT

curl -fsSL --retry 3 --connect-timeout 10 \
  "https://github.com/${REPO}/releases/download/${tag}/SHA256SUMS" \
  -o "$tmp_sums" || die "could not download SHA256SUMS for ${tag}"

expected=$(awk -v f="$asset" '{name=$2; sub(/^\*/, "", name); if (name == f) print $1}' "$tmp_sums")
[ -n "$expected" ] || die "SHA256SUMS does not list a digest for ${asset}"

mkdir -p "$INSTALL_DIR"

curl -fsSL --retry 3 --connect-timeout 10 --max-time 600 \
  "https://github.com/${REPO}/releases/download/${tag}/${asset}" \
  -o "$download_path" || die "could not download ${asset}"

actual=$(sha256 "$download_path")
if [ "$actual" != "$expected" ]; then
  die "checksum mismatch for ${asset}: expected ${expected}, got ${actual}"
fi

chmod +x "$download_path"
mv "$download_path" "${INSTALL_DIR}/${BIN_NAME}"

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
