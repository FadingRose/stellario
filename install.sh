#!/bin/sh
# stellario installer — downloads the release tarball, installs the binary,
# and links the agent skill. Works from GitHub Releases or a local dist/.
#
#   curl -fsSL https://raw.githubusercontent.com/FadingRose/stellario/main/install.sh | sh
#   VERSION=0.2.0 sh install.sh          # pin a version
#   LOCAL=dist sh install.sh             # install from a local build (make release)

set -e

REPO="FadingRose/stellario"
VERSION="${VERSION:-latest}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
SKILL_DIR="${SKILL_DIR:-$HOME/.agents/skills}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Detect platform (same naming as Makefile).
os="$(uname -s)"
arch="$(uname -m)"
case "$os-$arch" in
  Linux-x86_64)  PLATFORM="linux-amd64" ;;
  Darwin-arm64)  PLATFORM="darwin-arm64" ;;
  Darwin-x86_64) PLATFORM="darwin-amd64" ;;
  Linux-aarch64) PLATFORM="linux-arm64" ;;
  *) echo "unsupported platform: $os-$arch" >&2; exit 1 ;;
esac

if [ -n "$LOCAL" ]; then
  PKG="stella-${VERSION}-${PLATFORM}.tar.gz"
  tar xzf "$LOCAL/$PKG" -C "$TMP"
else
  URL="https://github.com/$REPO/releases/${VERSION}/download/stella-${VERSION}-${PLATFORM}.tar.gz"
  [ "$VERSION" = "latest" ] && URL="https://github.com/$REPO/releases/latest/download/stella-${PLATFORM}.tar.gz"
  echo "downloading $URL"
  curl -fsSL "$URL" -o "$TMP/pkg.tar.gz"
  tar xzf "$TMP/pkg.tar.gz" -C "$TMP"
fi

mkdir -p "$INSTALL_DIR" "$SKILL_DIR"
cp "$TMP"/*/stella "$INSTALL_DIR/stella"
ln -sf stella "$INSTALL_DIR/stellario"
cp "$TMP"/*/stellario-mcp "$INSTALL_DIR/" 2>/dev/null || true
cp "$TMP"/*/stellario-migrate "$INSTALL_DIR/" 2>/dev/null || true

# The agent skill — copied (the package is self-contained), read by
# kimi/codex/opencode from ~/.agents/skills/.
mkdir -p "$SKILL_DIR"
SKILL_SRC="$(find "$TMP" -type d -name stellario -path '*/skills/*' | head -1)"
rm -rf "$SKILL_DIR/stellario"
cp -r "$SKILL_SRC" "$SKILL_DIR/stellario"

echo "installed: $INSTALL_DIR/stella"
echo "skill:     $SKILL_DIR/stellario"
echo ""
echo "next: stella list            — see your capsules"
echo "      stella \"query\" \"intent\" — hybrid search (intent is mandatory)"
echo "      add a .stella/ dir anywhere + write an entry, then: stella sync"
