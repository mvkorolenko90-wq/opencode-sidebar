---
name: telegram
description: "Use when the user wants to control OpenCode from Telegram: install, start, stop, or troubleshoot the Telegram bot, choose the working folder, or keep task history in Telegram."
---

# Telegram

Готовый клиент [@grinev/opencode-telegram-bot](https://github.com/grinev/opencode-telegram-bot) для OpenCode. Своего бота не писать.

## Что нужно

- Токен бота: Telegram → [@BotFather](https://t.me/BotFather) → `/newbot` (или `/token`).
- Числовой Telegram ID: написать [@userinfobot](https://t.me/userinfobot).
- Node.js 22.14+ и OpenCode. Установщик поставит их сам, если их нет.

## Установка одной командой

Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\path\to\opencode-telegram\install.ps1"
```

Или двойной клик `opencode-telegram\Установить.bat`.

Linux/macOS:

```bash
bash /path/to/opencode-telegram/install.sh
```

Если репозитория нет под рукой:

```bash
npx @grinev/opencode-telegram-bot@latest
```

Мастер спросит токен, ID, версию OpenCode и модель.

## Управление

| Действие | Windows | Linux/macOS |
|---|---|---|
| Запустить | `Запустить.bat` | `bash start.sh` |
| Остановить | `Остановить.bat` | `bash stop.sh` |
| Статус | `Статус.bat` | `bash status.sh` |

После перезапуска OpenCode запускать заново: сервер V2 может сменить порт.

## Папка и история

- `/projects` — выбрать существующий проект.
- `/open` — добавить новую папку (доступные корни задаёт `OPEN_BROWSER_ROOTS`).
- `/status` — текущий проект и сессия.
- `/new` — новая сессия в текущем проекте.
- `/sessions` — история сессий проекта.

Каждый проект хранит свою историю. Пуш в GitHub работает, если текущая папка — git-репозиторий с remote.

## Если не работает

1. `opencode service status` — сервер запущен?
2. `opencode-telegram status` — бот запущен?
3. Логи:
   - Windows: `%APPDATA%\opencode-telegram-bot\logs\`
   - Linux: `~/.config/opencode-telegram-bot/logs/`
4. Ошибка авторизации OpenCode V2 — проверьте `opencode service get password` и `OPENCODE_SERVER_PASSWORD` в `.env`.
5. `opencode-telegram: command not found` — установщик ставит бинарник в `$(npm config get prefix)/bin` и создаёт ссылку в первый доступный каталог `PATH` (обычно `~/.local/bin`). Перезайдите в терминал или выполните:
   ```bash
   export PATH="$(npm config get prefix)/bin:$PATH"
   ```
