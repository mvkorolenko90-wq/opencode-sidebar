#!/usr/bin/env bash
# Обновление opencode Sidebar из GitHub Releases.
# Использование: bash update.sh [версия] [--force]
set -euo pipefail

REPO="mvkorolenko90-wq/opencode-sidebar"
EXT_ID="myai.opencode-sidebar"
CODE_BIN="${CODE_BIN:-code}"
FORCE=0
VERSION=""

usage() {
  cat <<'TXT'
Обновление opencode Sidebar из GitHub Releases.

Использование: bash update.sh [версия] [--force]

  версия     версия без префикса v, например 0.9.25; по умолчанию — последний релиз
  --force    переустановить, даже если эта версия уже установлена
  -h, --help показать эту справку

Переменная CODE_BIN задаёт CLI редактора (по умолчанию code).
TXT
}

for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --force|-f) FORCE=1 ;;
    -*) echo "Неизвестный параметр: $arg" >&2; usage >&2; exit 2 ;;
    *) VERSION="${arg#v}" ;;
  esac
done

CODE_PATH="$(command -v "$CODE_BIN" 2>/dev/null || true)"
if [ -z "$CODE_PATH" ] && [ "$CODE_BIN" = "code" ]; then
  CODE_PATH="$(command -v code-insiders 2>/dev/null || true)"
fi
if [ -z "$CODE_PATH" ]; then
  echo "Не найден CLI редактора «$CODE_BIN»." >&2
  echo "В VS Code: Ctrl+Shift+P → Shell Command: Install 'code' command in PATH." >&2
  echo "Либо скачайте VSIX и установите вручную: https://github.com/${REPO}/releases/latest" >&2
  exit 1
fi

if [ -n "$VERSION" ]; then
  API="https://api.github.com/repos/${REPO}/releases/tags/v${VERSION}"
else
  API="https://api.github.com/repos/${REPO}/releases/latest"
fi

echo "Запрашиваю GitHub Releases…"
if ! JSON="$(curl -fsSL -H 'Accept: application/vnd.github+json' -H 'User-Agent: opencode-sidebar-updater' "$API")"; then
  echo "Не удалось получить данные релиза." >&2
  echo "Проверьте сеть и версию: https://github.com/${REPO}/releases" >&2
  exit 1
fi

TAG="$(printf '%s' "$JSON" | sed -n 's/.*"tag_name" *: *"v\{0,1\}\([^"]*\)".*/\1/p' | head -1)"
ASSET_URL="$(printf '%s' "$JSON" | tr ',' '\n' | grep -o 'https://[^"]*\.vsix' | head -1 || true)"

if [ -z "$TAG" ] || [ -z "$ASSET_URL" ]; then
  echo "В релизе не найден VSIX-файл: https://github.com/${REPO}/releases" >&2
  exit 1
fi

INSTALLED="$("$CODE_PATH" --list-extensions --show-versions 2>/dev/null | awk -F@ -v id="$EXT_ID" 'tolower($1) == id { print $2; exit }')"

if [ "$INSTALLED" = "$TAG" ] && [ "$FORCE" -eq 0 ]; then
  echo "Уже установлена последняя версия: $TAG"
  echo "Переустановить: bash update.sh --force"
  exit 0
fi

if [ -n "$INSTALLED" ]; then
  echo "Установлено: $INSTALLED → ставим: $TAG"
else
  echo "Расширение не найдено, ставим версию $TAG"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
VSIX="$TMP/$(basename "$ASSET_URL")"

echo "Скачиваю $(basename "$ASSET_URL")…"
curl -fL --progress-bar -o "$VSIX" "$ASSET_URL"

"$CODE_PATH" --install-extension "$VSIX" --force

echo
echo "Установлено: opencode Sidebar $TAG"
echo "Перезагрузите окно VS Code: Ctrl+Shift+P → Developer: Reload Window"
