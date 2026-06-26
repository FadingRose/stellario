#!/bin/sh
# Stellario installer — downloads the binary for your platform and runs setup.
#
# Usage:
#   curl -fsSL https://github.com/FadingRose/stellario/releases/latest/download/install.sh | sh
#
# Or from a specific version:
#   curl -fsSL https://raw.githubusercontent.com/FadingRose/stellario/main/install.sh | sh -s -- --version v1.0.0-beta.7

set -e

REPO="FadingRose/stellario"
VERSION="${stellario_version:-latest}"
INSTALL_DIR="${STELLARIO_INSTALL_DIR:-$HOME/.local/bin}"

# Parse args
while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      VERSION="$2"
      shift 2
      ;;
    --version=*)
      VERSION="${1#--version=}"
      shift
      ;;
    --dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --dir=*)
      INSTALL_DIR="${1#--dir=}"
      shift
      ;;
    --help|-h)
      echo "Usage: curl -fsSL ... | sh [-s -- --version v1.0.0-beta.7 --dir ~/.local/bin]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Detect platform
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

# Normalize arch
case "$ARCH" in
  x86_64|amd64) ARCH="amd64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

case "$OS" in
  darwin|linux) ;;
  *)
    echo "Unsupported OS: $OS (stellario supports darwin and linux)"
    exit 1
    ;;
esac

BINARY_NAME="stellario-$OS-$ARCH"

# Resolve download URL
if [ "$VERSION" = "latest" ]; then
  DOWNLOAD_URL="https://github.com/$REPO/releases/latest/download/$BINARY_NAME"
else
  DOWNLOAD_URL="https://github.com/$REPO/releases/download/$VERSION/$BINARY_NAME"
fi

echo "Stellario Installer"
echo "═══════════════════════════════════════════════════════"
echo "  Platform:  $OS/$ARCH"
echo "  Version:   $VERSION"
echo "  Install:   $INSTALL_DIR/stellario"
echo ""

# Create install directory
mkdir -p "$INSTALL_DIR"

# Download
echo "Downloading..."
if ! curl -fsSL "$DOWNLOAD_URL" -o "$INSTALL_DIR/stellario"; then
  echo ""
  echo "Download failed. Check your platform and version:"
  echo "  URL: $DOWNLOAD_URL"
  echo ""
  echo "Available releases: https://github.com/$REPO/releases"
  exit 1
fi

chmod +x "$INSTALL_DIR/stellario"

echo "  ✓ Downloaded"

# Verify it runs
VERSION_OUTPUT=$("$INSTALL_DIR/stellario" version 2>&1) || true
echo "  ✓ $VERSION_OUTPUT"

# Check if install dir is in PATH
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo ""
    echo "⚠ $INSTALL_DIR is not in your PATH."
    echo "  Add this to your shell config:"
    echo ""
    echo "    export PATH=\"$INSTALL_DIR:\$PATH\""
    echo ""
    echo "  Then restart your terminal, or run:"
    echo "    $INSTALL_DIR/stellario setup"
    exit 0
    ;;
esac

# Run setup
echo ""
echo "Running setup..."
exec stellario setup
