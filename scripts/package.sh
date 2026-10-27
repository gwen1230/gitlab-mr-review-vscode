#!/usr/bin/env bash
# Construit le .vsix sans vsce : un zip avec le manifeste VSIX et l'extension sous extension/.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(jq -r .version "$root/package.json")"
out="$root/mr-review-$version.vsix"
build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT

mkdir -p "$build/extension"
cp -R "$root/package.json" "$root/extension.js" "$root/src" "$root/media" "$root/README.md" "$build/extension/"
sed "s/__VERSION__/$version/" "$root/packaging/extension.vsixmanifest" > "$build/extension.vsixmanifest"
cp "$root/packaging/content-types.xml" "$build/[Content_Types].xml"

rm -f "$out"
(cd "$build" && zip -qr "$out" '[Content_Types].xml' extension.vsixmanifest extension)
echo "$out"
