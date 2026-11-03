#!/usr/bin/env bash
# Construit le .vsix sans vsce : un zip avec le manifeste VSIX, généré depuis package.json, et
# l'extension sous extension/.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
field() { jq -r "$1" "$root/package.json"; }
xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'; }

name="$(field .name)"
version="$(field .version)"
publisher="$(field .publisher)"
display_name="$(field .displayName | xml)"
# La description du manifeste est une clé %…% : sa valeur anglaise est dans package.nls.json.
description="$(jq -r '.description' "$root/package.nls.json" | xml)"
categories="$(field '.categories | join(",")' | xml)"
tags="$(field '.keywords | join(",")' | xml)"
engine="$(field .engines.vscode)"
dependencies="$(field '.extensionDependencies // [] | join(",")')"
repository="$(field .repository.url | sed 's/\.git$//')"
out="$root/$name-$version.vsix"
build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT

mkdir -p "$build/extension"
cp -R "$root/package.json" "$root/package.nls.json" "$root/package.nls.fr.json" "$root/extension.js" \
  "$root/src" "$root/l10n" "$root/media" "$root/README.md" "$root/README.fr.md" "$root/CHANGELOG.md" \
  "$build/extension/"
cp "$root/LICENSE" "$build/extension/LICENSE.txt"

cat > "$build/extension.vsixmanifest" <<XML
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="$name" Version="$version" Publisher="$publisher" />
    <DisplayName>$display_name</DisplayName>
    <Description xml:space="preserve">$description</Description>
    <Tags>$tags</Tags>
    <Categories>$categories</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$engine" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="$dependencies" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="$repository.git" />
      <Property Id="Microsoft.VisualStudio.Services.Links.GitHub" Value="$repository.git" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="$repository/issues" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Learn" Value="$repository#readme" />
    </Properties>
    <License>extension/LICENSE.txt</License>
    <Icon>extension/media/icon.png</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/media/icon.png" Addressable="true" />
  </Assets>
</PackageManifest>
XML
cp "$root/packaging/content-types.xml" "$build/[Content_Types].xml"

rm -f "$out"
(cd "$build" && zip -qr "$out" '[Content_Types].xml' extension.vsixmanifest extension)
echo "$out"
