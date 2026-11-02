#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

VERSION="$(node -p "require('./package.json').version")"
VSIX="opencode-sidebar-${VERSION}.vsix"

npx --yes @vscode/vsce package --allow-missing-repository --out "$VSIX"
code --install-extension "$VSIX" --force

printf '\nУстановлено: %s\n' "$VSIX"
printf 'Перезагрузите окно VS Code: Ctrl+Shift+P → Developer: Reload Window\n'
