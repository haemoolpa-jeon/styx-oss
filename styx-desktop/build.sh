#!/bin/bash
# Build script for Styx - generates both production and dev versions

set -e

cd "$(dirname "$0")/src-tauri"

echo "🔨 Building Styx..."

# Build production version (devtools disabled)
echo "📦 Building production version..."
sed -i 's/"devtools": true/"devtools": false/' tauri.conf.json
cargo tauri build --bundles msi,nsis 2>&1 | tail -20

# Rename production artifacts
if [ -d "target/release/bundle/msi" ]; then
  for f in target/release/bundle/msi/*.msi; do
    mv "$f" "${f%.msi}-prod.msi" 2>/dev/null || true
  done
fi
if [ -d "target/release/bundle/nsis" ]; then
  for f in target/release/bundle/nsis/*.exe; do
    mv "$f" "${f%.exe}-prod.exe" 2>/dev/null || true
  done
fi

# Build dev version (devtools enabled)
echo "🔧 Building dev version..."
sed -i 's/"devtools": false/"devtools": true/' tauri.conf.json
cargo tauri build --bundles msi,nsis 2>&1 | tail -20

# Rename dev artifacts
if [ -d "target/release/bundle/msi" ]; then
  for f in target/release/bundle/msi/*.msi; do
    [[ "$f" != *"-prod.msi" ]] && mv "$f" "${f%.msi}-dev.msi" 2>/dev/null || true
  done
fi
if [ -d "target/release/bundle/nsis" ]; then
  for f in target/release/bundle/nsis/*.exe; do
    [[ "$f" != *"-prod.exe" ]] && mv "$f" "${f%.exe}-dev.exe" 2>/dev/null || true
  done
fi

# Reset to production config
sed -i 's/"devtools": true/"devtools": false/' tauri.conf.json

echo "✅ Build complete!"
echo "📁 Artifacts in: src-tauri/target/release/bundle/"
ls -la target/release/bundle/msi/ 2>/dev/null || true
ls -la target/release/bundle/nsis/ 2>/dev/null || true
