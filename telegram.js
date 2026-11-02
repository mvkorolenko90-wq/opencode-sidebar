'use strict';

// Управление готовым Telegram-ботом OpenCode: запуск, остановка, автозапуск.
// Бот не патчится — используются его CLI и штатные скрипты проекта.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'opencode-telegram';

function appHome() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'opencode-telegram-bot');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'opencode-telegram-bot');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode-telegram-bot');
}

function resolveHome(configured, workspacePath) {
  const candidates = [];
  if (configured) {
    candidates.push(configured);
  }
  if (workspacePath) {
    candidates.push(path.join(workspacePath, 'opencode-telegram'));
  }
  candidates.push(path.join(os.homedir(), 'opencode-telegram'));
  candidates.push(path.join(os.homedir(), 'MyAi', 'opencode-telegram'));
  candidates.push(path.join(os.homedir(), 'MyAi', 'Site', 'opencode-telegram'));
  if (process.platform === 'win32') {
    candidates.push('E:\\MyAi\\opencode-telegram');
  }
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'start.ps1')) && fs.existsSync(path.join(dir, 'install.ps1'))) {
      return dir;
    }
  }
  return configured || candidates[candidates.length - 1] || '';
}

function scriptsPresent(home) {
  return Boolean(home && fs.existsSync(path.join(home, 'start.ps1')) && fs.existsSync(path.join(home, 'install.ps1')));
}

function configured() {
  return fs.existsSync(path.join(appHome(), '.env'));
}

function validateCredentials(token, userId) {
  const value = String(token || '').trim();
  const id = String(userId || '').trim();
  if (!/^[0-9]{6,}:[A-Za-z0-9_-]{30,}$/.test(value)) {
    throw new Error('Токен не похож на токен Telegram.');
  }
  if (!/^[0-9]+$/.test(id)) {
    throw new Error('Telegram ID должен состоять только из цифр.');
  }
  return { token: value, userId: id };
}

function writeCredentials(token, userId) {
  const values = validateCredentials(token, userId);
  const dir = appHome();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.env');
  const entries = new Map();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (match) {
        entries.set(match[1], match[2]);
      }
    }
  } catch {
    // конфига ещё нет
  }
  entries.set('TELEGRAM_BOT_TOKEN', values.token);
  entries.set('TELEGRAM_ALLOWED_USER_ID', values.userId);
  const body = [...entries.entries()].map(([key, value]) => key + '=' + value).join('\n') + '\n';
  fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows не использует POSIX-права
  }
  return file;
}

function runInstaller(home, token) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const script = path.join(home, isWin ? 'install.ps1' : 'install.sh');
    if (!fs.existsSync(script)) {
      reject(new Error('Не найден установщик: ' + script));
      return;
    }
    const env = {
      ...process.env,
      PATH: [process.env.PATH, path.join(os.homedir(), '.local', 'bin')].filter(Boolean).join(path.delimiter)
    };
    const child = isWin
      ? spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { cwd: home, env, windowsHide: true })
      : spawn('/bin/bash', [script], { cwd: home, env });
    let output = '';
    const push = (chunk) => {
      output = (output + chunk.toString()).slice(-16000);
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* уже завершился */ }
      reject(new Error('Установка не завершилась за 15 минут.'));
    }, 900000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = output
        .replace(/\x1b\[[0-9;]*m/g, '')
        .split(token)
        .join('[токен скрыт]')
        .trim();
      const tail = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-8).join('\n');
      if (code === 0) {
        resolve(tail);
        return;
      }
      reject(new Error(tail || 'Установщик завершился с кодом ' + code));
    });
  });
}

async function install(home, token, userId) {
  if (!scriptsPresent(home)) {
    throw new Error('Не найдена папка opencode-telegram. Укажите её в настройке opencodeSidebar.telegramPath.');
  }
  const prereq = await prerequisites();
  if (!prereq.ready) {
    const error = new Error('Не хватает: ' + prereq.missing.map((item) => item.text).join(', ') + '.');
    error.missing = prereq.missing;
    throw error;
  }
  writeCredentials(token, userId);
  await runInstaller(home, String(token || '').trim());
  cliCache = undefined;
  return 'Бот установлен и запущен.';
}

function runProcess(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, {
      windowsHide: true,
      timeout: 180000,
      maxBuffer: 4 * 1024 * 1024,
      ...options
    }, (error, stdout, stderr) => {
      const text = (String(stdout || '') + String(stderr || '')).trim();
      resolve({ ok: !error, text: text || (error ? error.message : '') });
    });
  });
}

let cliCache;

async function cliPath() {
  if (cliCache) {
    return cliCache;
  }
  const result = process.platform === 'win32'
    ? await runProcess('cmd.exe', ['/d', '/s', '/c', 'npm root -g'])
    : await runProcess('npm', ['root', '-g']);
  const lines = result.ok ? result.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
  const root = lines.slice().reverse().find((line) => path.isAbsolute(line)) || '';
  const file = root ? path.join(root, '@grinev', 'opencode-telegram-bot', 'dist', 'cli.js') : '';
  if (file && fs.existsSync(file)) {
    cliCache = file;
    return cliCache;
  }
  return '';
}

async function runCli(args) {
  const cli = await cliPath();
  if (!cli) {
    throw new Error('Пакет @grinev/opencode-telegram-bot не установлен.');
  }
  return runProcess(process.platform === 'win32' ? 'node.exe' : 'node', [cli, ...args], { cwd: appHome() });
}

async function autostartEnabled() {
  if (process.platform === 'win32') {
    const result = await runProcess('reg', ['query', RUN_KEY, '/v', RUN_VALUE]);
    return result.ok;
  }
  if (process.platform === 'linux') {
    const unit = path.join(os.homedir(), '.config', 'systemd', 'user', 'opencode-telegram.service');
    if (fs.existsSync(unit)) {
      const result = await runProcess('systemctl', ['--user', 'is-enabled', 'opencode-telegram.service']);
      if (result.ok) {
        return true;
      }
    }
    return fs.existsSync(path.join(os.homedir(), '.config', 'autostart', 'opencode-telegram.desktop'));
  }
  return false;
}

async function autostartOn(home) {
  if (!scriptsPresent(home)) {
    throw new Error('Не найдена папка opencode-telegram со start.ps1.');
  }
  if (process.platform === 'win32') {
    const vbs = path.join(appHome(), 'opencode-telegram-run.vbs');
    const script = path.join(home, 'start.ps1');
    const body = [
      'Set shell = CreateObject("WScript.Shell")',
      'shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""' + script + '""", 0, False',
      ''
    ].join('\r\n');
    fs.mkdirSync(appHome(), { recursive: true });
    fs.writeFileSync(vbs, '\ufeff' + body, 'utf16le');
    const result = await runProcess('reg', [
      'add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', 'wscript.exe "' + vbs + '"', '/f'
    ]);
    if (!result.ok) {
      throw new Error('Не удалось включить автозапуск в реестре.');
    }
    return 'Автозапуск включён: бот будет стартовать при входе в Windows.';
  }
  if (process.platform === 'linux') {
    const script = path.join(home, 'start.sh');
    const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    const unitFile = path.join(unitDir, 'opencode-telegram.service');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(unitFile, [
      '[Unit]',
      'Description=OpenCode Telegram bot',
      'After=network-online.target',
      '',
      '[Service]',
      'Type=oneshot',
      'ExecStart=/bin/bash "' + script + '"',
      '',
      '[Install]',
      'WantedBy=default.target',
      ''
    ].join('\n'), 'utf8');
    const reload = await runProcess('systemctl', ['--user', 'daemon-reload']);
    if (reload.ok) {
      const enable = await runProcess('systemctl', ['--user', 'enable', 'opencode-telegram.service']);
      if (enable.ok) {
        return 'Автозапуск включён: служба systemd --user.';
      }
    }
    const autostartDir = path.join(os.homedir(), '.config', 'autostart');
    fs.mkdirSync(autostartDir, { recursive: true });
    fs.writeFileSync(path.join(autostartDir, 'opencode-telegram.desktop'), [
      '[Desktop Entry]',
      'Type=Application',
      'Name=OpenCode Telegram',
      'Exec=/bin/bash "' + script + '"',
      'X-GNOME-Autostart-enabled=true',
      ''
    ].join('\n'), 'utf8');
    return 'Автозапуск включён через ~/.config/autostart.';
  }
  throw new Error('Автозапуск поддерживается на Windows и Linux.');
}

async function autostartOff() {
  if (process.platform === 'win32') {
    await runProcess('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
    try {
      fs.rmSync(path.join(appHome(), 'opencode-telegram-run.vbs'), { force: true });
    } catch {
      // файл мог не создаваться
    }
    return 'Автозапуск выключен.';
  }
  if (process.platform === 'linux') {
    await runProcess('systemctl', ['--user', 'disable', 'opencode-telegram.service']);
    try {
      fs.rmSync(path.join(os.homedir(), '.config', 'systemd', 'user', 'opencode-telegram.service'), { force: true });
    } catch {
      // файла могло не быть
    }
    try {
      fs.rmSync(path.join(os.homedir(), '.config', 'autostart', 'opencode-telegram.desktop'), { force: true });
    } catch {
      // файла могло не быть
    }
    await runProcess('systemctl', ['--user', 'daemon-reload']);
    return 'Автозапуск выключен.';
  }
  throw new Error('Автозапуск поддерживается на Windows и Linux.');
}

function versionAtLeast(value, major, minor) {
  const match = String(value || '').match(/(\d+)\.(\d+)/);
  if (!match) {
    return false;
  }
  const currentMajor = Number(match[1]);
  const currentMinor = Number(match[2]);
  return currentMajor > major || (currentMajor === major && currentMinor >= minor);
}

async function prerequisites() {
  const missing = [];
  let node = '';
  const nodeResult = await runProcess(process.platform === 'win32' ? 'node.exe' : 'node', ['-v'], { timeout: 10000 });
  if (nodeResult.ok) {
    node = nodeResult.text.trim();
  }
  if (!versionAtLeast(node, 22, 14)) {
    missing.push({ id: 'node', text: 'Node.js 22.14+' });
  }

  let opencode = '';
  const opencodeResult = process.platform === 'win32'
    ? await runProcess('cmd.exe', ['/d', '/s', '/c', 'where opencode 2>nul && opencode --version 2>nul'], { timeout: 10000 })
    : await runProcess('/bin/sh', ['-lc', 'command -v opencode && opencode --version'], { timeout: 10000 });
  if (opencodeResult.ok) {
    const lines = opencodeResult.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    opencode = lines.find((line) => /v?\d+\.\d+\.\d+/.test(line)) || lines[0] || '';
  }
  if (!opencode) {
    missing.push({ id: 'opencode', text: 'OpenCode CLI' });
  }

  let model = '';
  try {
    const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'opencode', 'opencode.json'), 'utf8'));
    model = typeof config.model === 'string' ? config.model : '';
  } catch {
    // конфига ещё нет
  }
  if (!model || !model.includes('/')) {
    missing.push({ id: 'model', text: 'модель OpenCode (provider/model)' });
  }

  return { ready: missing.length === 0, missing, node, opencode, model };
}

async function status(home) {
  const installed = Boolean(await cliPath());
  const ready = configured();
  const autostart = await autostartEnabled();
  const prereq = await prerequisites();
  if (!installed) {
    return { installed: false, configured: ready, running: false, autostart, prereq, text: 'Пакет бота не установлен. Нажмите «Установить».' };
  }
  if (!ready) {
    return { installed: true, configured: false, running: false, autostart, prereq, text: 'Бот не настроен: нужен токен @BotFather. Нажмите «Установить».' };
  }
  const result = await runCli(['status']);
  const running = /Service status: running/.test(result.text);
  const lines = result.text.split(/\r?\n/).filter((line) => line.trim() && !/^Service status:/.test(line));
  return { installed: true, configured: true, running, autostart, prereq, text: lines.join('\n') };
}

async function start(home) {
  let command;
  let args;
  let cwd;
  if (scriptsPresent(home)) {
    command = process.platform === 'win32' ? 'powershell.exe' : 'bash';
    args = process.platform === 'win32'
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(home, 'start.ps1')]
      : [path.join(home, 'start.sh')];
    cwd = home;
  } else {
    const cli = await cliPath();
    if (!cli) {
      throw new Error('Пакет @grinev/opencode-telegram-bot не установлен.');
    }
    command = process.platform === 'win32' ? 'node.exe' : 'node';
    args = [cli, 'start', '--daemon'];
    cwd = appHome();
  }
  const logFile = path.join(appHome(), 'logs', 'telegram-start.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  try {
    fs.writeFileSync(logFile, '');
  } catch {
    // лог необязателен
  }
  const logHandle = fs.openSync(logFile, 'a');
  const child = spawn(command, args, {
    cwd,
    stdio: ['ignore', logHandle, logHandle],
    windowsHide: true
  });
  fs.closeSync(logHandle);
  child.on('error', () => {
    // ошибку покажет опрос статуса
  });
  child.unref();
  for (let attempt = 0; attempt < 45; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const state = await runCli(['status']);
    if (/Service status: running/.test(state.text)) {
      return 'Бот запущен.';
    }
  }
  const tail = readTail(logFile, 6);
  return 'Бот не запустился за 45 секунд.' + (tail ? '\n' + tail : '') + '\nЛог: ' + logFile;
}

function readTail(file, lines) {
  try {
    const text = fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/);
    return text.slice(-lines).join('\n');
  } catch {
    return '';
  }
}

async function action(home, name) {
  if (name === 'status') {
    return (await status(home)).text;
  }
  if (name === 'autostart') {
    return (await autostartEnabled()) ? autostartOff() : autostartOn(home);
  }
  if (name === 'stop') {
    const result = await runCli(['stop']);
    return result.ok ? 'Бот остановлен.' : result.text;
  }
  if (name === 'start') {
    return start(home);
  }
  if (name === 'restart') {
    await runCli(['stop']);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return start(home);
  }
  throw new Error('Неизвестное действие: ' + name);
}

module.exports = { appHome, resolveHome, scriptsPresent, status, action, install, writeCredentials, validateCredentials, prerequisites, versionAtLeast };
