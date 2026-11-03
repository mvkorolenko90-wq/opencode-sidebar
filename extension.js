'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { startOpencodeWebUi, apiGet, apiPost, reloadOpencode } = require('./webui');
const telegram = require('./telegram');
const updates = require('./updates');

const VIEW_ID = 'opencodeSidebar.main';const TERMINAL_NAME = 'opencode';
const PORT_STATE_KEY = 'opencodeSidebar.ports';

let activeProvider = null;

function scopeHash(value) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash * 33) ^ value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function workspaceScope() {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  return folder ? folder.uri.fsPath : 'default';
}

function globalSkillsDir() {
  return path.join(os.homedir(), '.config', 'opencode', 'skills');
}

function pathEntries() {
  const entries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    entries.push(
      path.join(appData, 'npm'),
      path.join(localAppData, 'node'),
      path.join(localAppData, 'Programs', 'nodejs'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
      path.join(home, '.local', 'bin')
    );
  } else {
    entries.push(path.join(home, '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin');
  }
  return [...new Set(entries)];
}

function binaryPath(name) {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const dir of pathEntries()) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if (process.platform === 'win32') {
          if (fs.existsSync(file)) return file;
        } else {
          fs.accessSync(file, fs.constants.X_OK);
          return file;
        }
      } catch {
        // not here — keep looking
      }
    }
  }
  return null;
}

function configFiles() {
  const files = [opencodeConfigPath()];
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (folder) {
    files.push(path.join(folder.uri.fsPath, 'opencode.json'));
    files.push(path.join(folder.uri.fsPath, '.opencode', 'opencode.json'));
  }
  return [...new Set(files)];
}

function hasMcpServer(name) {
  for (const file of configFiles()) {
    try {
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      const table = (config.mcp && (config.mcp.servers || config.mcp)) || config.mcpServers;
      if (table && typeof table === 'object' && table[name]) return true;
    } catch {
      // no config or not valid JSON — try the next one
    }
  }
  return false;
}

function unmetRequirements(requires) {
  const missing = [];
  if (!requires || typeof requires !== 'object') return missing;
  if (requires.binary && !binaryPath(String(requires.binary))) {
    missing.push('не найден ' + requires.binary);
  }
  if (requires.mcp && !hasMcpServer(String(requires.mcp))) {
    missing.push('нет MCP ' + requires.mcp + ' в opencode.json');
  }
  return missing;
}

function setupCommand(step) {
  if (!step || typeof step !== 'object') return '';
  const command = process.platform === 'win32' ? step.windows : step.command;
  return typeof command === 'string' ? command.trim() : '';
}

// Порядок установки: сначала внешние программы (uv, Node.js), затем сам
// бинарник зависимости, затем MCP-запись. На одном шаге список не строится —
// после установки предыдущего бинарника следующий может стать доступен.
function requirementSteps(entry) {
  const setup = entry.setup && typeof entry.setup === 'object' ? entry.setup : {};
  const requires = entry.requires && typeof entry.requires === 'object' ? entry.requires : {};
  const steps = [];
  const prerequisites = Array.isArray(setup.prerequisites) ? setup.prerequisites : [];
  for (const item of prerequisites) {
    if (!item || typeof item !== 'object') continue;
    const binary = String(item.binary || '');
    if (!binary || binaryPath(binary)) continue;
    steps.push({
      kind: 'prerequisite',
      title: String(item.title || binary),
      binary: binary,
      command: setupCommand(item)
    });
  }
  if (requires.binary && !binaryPath(String(requires.binary))) {
    steps.push({
      kind: 'binary',
      title: String(requires.binary),
      binary: String(requires.binary),
      command: setupCommand(setup.binary)
    });
  }
  if (requires.mcp && !hasMcpServer(String(requires.mcp))) {
    steps.push({ kind: 'mcp', title: 'MCP ' + requires.mcp, binary: '', command: '' });
  }
  return steps;
}

function runSetupCommand(command) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const child = isWin
      ? spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true })
      : spawn('/bin/bash', ['-lc', command]);
    let output = '';
    const push = (chunk) => {
      output = (output + chunk.toString()).slice(-8000);
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      reject(new Error('Установка не завершилась за 10 минут.'));
    }, 600000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(output.trim());
        return;
      }
      const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((line) => line.trim()).filter(Boolean);
      reject(new Error(lines.length ? lines[lines.length - 1] : 'Команда завершилась с кодом ' + code));
    });
  });
}

function addMcpServer(name, definition) {
  const file = opencodeConfigPath();
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (config.mcp && !config.mcp.servers && typeof config.mcp === 'object') {
    config.mcp[name] = definition;
  } else if (config.mcpServers && !config.mcp) {
    config.mcpServers[name] = definition;
  } else {
    config.mcp = config.mcp || {};
    config.mcp.servers = config.mcp.servers || {};
    config.mcp.servers[name] = definition;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(file, file + '.bak-' + stamp);
  fs.writeFileSync(file, JSON.stringify(config, null, '\t') + '\n', 'utf8');
  return file;
}

function readManifest(extensionUri) {
  try {
    const raw = fs.readFileSync(path.join(extensionUri.fsPath, 'skills', 'manifest.json'), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.skills) ? data.skills : [];
  } catch {
    return [];
  }
}

function manifestEntry(extensionUri, id) {
  return readManifest(extensionUri).find((item) => String(item.id || '') === id) || null;
}

function readRecommended(extensionUri) {
  return readManifest(extensionUri).map((item) => {
    const id = String(item.id || '');
    const type = item.type === 'agent' ? 'agent' : 'skill';
    const installed = type === 'agent'
      ? Boolean(id && readAgentEntry(id))
      : Boolean(id) && fs.existsSync(path.join(globalSkillsDir(), id, 'SKILL.md'));
    const missing = unmetRequirements(item.requires);
    const steps = requirementSteps(item);
    const setup = item.setup && typeof item.setup === 'object' ? item.setup : {};
    return {
      id: id,
      type: type,
      title: String(item.title || id),
      description: String(item.description || ''),
      installed: installed,
      missing: missing,
      plan: steps.map((step) => step.title),
      ready: installed && missing.length === 0,
      fixable: steps.length > 0 && steps.every((step) => (
        step.kind === 'mcp' ? Boolean(setup.mcp) : Boolean(step.command)
      ))
    };
  });
}

function installSkill(extensionUri, id) {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
    throw new Error('Некорректное имя скилла.');
  }
  const source = path.join(extensionUri.fsPath, 'skills', id);
  if (!fs.existsSync(path.join(source, 'SKILL.md'))) {
    throw new Error('Скилл не найден в пакете расширения: ' + id);
  }
  const target = path.join(globalSkillsDir(), id);
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  return target;
}

function opencodeConfigPath() {
  return path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
}

function readAgentEntry(id) {
  try {
    const config = JSON.parse(fs.readFileSync(opencodeConfigPath(), 'utf8'));
    const list = config.agents || config.agent || {};
    return list[id] || null;
  } catch {
    return null;
  }
}

function installAgent(extensionUri, id) {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
    throw new Error('Некорректное имя агента.');
  }
  const source = path.join(extensionUri.fsPath, 'agents', id + '.json');
  if (!fs.existsSync(source)) {
    throw new Error('Агент не найден в пакете расширения: ' + id);
  }
  const definition = JSON.parse(fs.readFileSync(source, 'utf8'));
  const file = opencodeConfigPath();
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const key = config.agents ? 'agents' : (config.agent ? 'agent' : 'agents');
  config[key] = config[key] || {};
  config[key][id] = { ...(config[key][id] || {}), ...definition };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(file, file + '.bak-' + stamp);
  fs.writeFileSync(file, JSON.stringify(config, null, '\t') + '\n', 'utf8');
  return file;
}

function readDefaultAgent() {
  try {
    const config = JSON.parse(fs.readFileSync(opencodeConfigPath(), 'utf8'));
    return config.default_agent ? String(config.default_agent) : 'build';
  } catch {
    return 'build';
  }
}

function setDefaultModel(providerID, modelID) {
  if (!providerID || !modelID) {
    throw new Error('Не указана модель.');
  }
  const file = opencodeConfigPath();
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  config.model = providerID + '/' + modelID;
  fs.copyFileSync(file, file + '.bak-' + stamp);
  fs.writeFileSync(file, JSON.stringify(config, null, '\t') + '\n', 'utf8');
  return config.model;
}

function setDefaultAgent(id) {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
    throw new Error('Некорректное имя агента.');
  }
  const file = opencodeConfigPath();
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  config.default_agent = id;
  fs.copyFileSync(file, file + '.bak-' + stamp);
  fs.writeFileSync(file, JSON.stringify(config, null, '\t') + '\n', 'utf8');
  return file;
}

function skillInstalled(id) {
  const roots = [globalSkillsDir()];
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (folder) {
    roots.push(path.join(folder.uri.fsPath, '.opencode', 'skills'));
    roots.push(path.join(folder.uri.fsPath, '.agents', 'skills'));
  }
  return roots.some((root) => fs.existsSync(path.join(root, id, 'SKILL.md')));
}

function telegramHome() {
  const configured = vscode.workspace.getConfiguration('opencodeSidebar').get('telegramPath') || '';
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  return telegram.resolveHome(configured, folder ? folder.uri.fsPath : '');
}

function telegramStatus() {
  return telegram.status(telegramHome());
}

function telegramInstallerTerminal() {
  const home = telegramHome();
  const terminal = vscode.window.createTerminal({ name: 'Telegram-бот', cwd: home });
  terminal.show();
  if (process.platform === 'win32') {
    terminal.sendText('powershell -NoProfile -ExecutionPolicy Bypass -File "' + path.join(home, 'install.ps1') + '"');
  } else {
    terminal.sendText('bash "' + path.join(home, 'install.sh') + '"');
  }
}

async function telegramAction(action) {
  if (action === 'install') {
    if (!telegram.scriptsPresent(telegramHome())) {
      throw new Error('Не найдена папка opencode-telegram. Укажите её в настройке opencodeSidebar.telegramPath.');
    }
    telegramInstallerTerminal();
    return 'Установка идёт в терминале. Введите токен @BotFather и свой Telegram ID.';
  }
  return telegram.action(telegramHome(), action);
}

async function installVsix(file) {
  const uri = vscode.Uri.file(file);
  try {
    await vscode.commands.executeCommand('workbench.extensions.installExtension', uri);
    return;
  } catch {
    // Fall back to the CLI when the running build does not accept a VSIX URI.
  }
  await updates.installWithCli(file);
}

class OpencodeViewProvider {
  constructor(context) {
    this.context = context;
    this.extensionUri = context.extensionUri;
    this.view = null;
    this.webUi = null;
    this.webUiStarting = null;
    this.embeddedUrl = null;
    this.embedding = false;
    this.disposed = false;
    this.port = 0;
    this.cliBinary = undefined;
    this.agents = null;
    this.pendingReload = false;
    this.fullPanel = null;
    this.fullRestoreSidebar = false;
    this.updating = false;
    this.installedVersion = '';
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    this.disposed = false;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webviewView.webview.onDidReceiveMessage((message) => this.onMessage(message));
    webviewView.webview.html = renderHtml(webviewView.webview, this.extensionUri);
    vscode.commands.executeCommand('setContext', 'opencodeSidebarOpen', Boolean(webviewView.visible));
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.fullRestoreSidebar = false;
      }
      vscode.commands.executeCommand('setContext', 'opencodeSidebarOpen', Boolean(webviewView.visible));
    });
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = null;
        vscode.commands.executeCommand('setContext', 'opencodeSidebarOpen', false);
        this.dispose();
      }
    });
  }

  async onMessage(message) {
    if (!message || typeof message !== 'object') {
      return;
    }

    try {
      if (message.type === 'ready') {
        if (this.embeddedUrl) {
          this.post({ type: 'embedded', url: this.embeddedUrl });
        } else {
          await this.openEmbedded();
        }
        return;
      }

      if (message.type === 'reloadEmbedded') {
        await this.reloadEmbedded();
      }

      if (message.type === 'openFull') {
        try {
          await this.openFullView(typeof message.url === 'string' ? message.url : '');
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage('Не удалось открыть opencode на весь экран: ' + text);
        }
        return;
      }

      if (message.type === 'installOpencode') {
        const terminal = vscode.window.createTerminal({ name: 'opencode install' });
        terminal.show();
        terminal.sendText('npm install -g @opencode/cli@latest');
        return;
      }

      if (message.type === 'capabilities') {
        this.post({ type: 'capabilities', graphify: skillInstalled('graphify') });
        return;
      }

      if (message.type === 'checkUpdates') {
        await this.checkUpdates();
        return;
      }

      if (message.type === 'graphify' && typeof message.sessionID === 'string') {
        try {
          await this.runGraphify(message.sessionID);
          this.post({ type: 'graphifyStarted', ok: true });
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          this.post({ type: 'graphifyStarted', ok: false, message: text });
        }
        return;
      }

			if (message.type === 'compact' && typeof message.sessionID === 'string') {
				try {
					if (this.cliBinary === undefined) {
						this.cliBinary = (await detectCli()).binary;
					}
					const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
					const cwd = folder ? folder.uri.fsPath : undefined;
					const active = await apiGet(this.cliBinary, cwd, '/api/session/active');
					if (!active || !active.data) {
						throw new Error('Не удалось проверить активность сессии.');
					}
					if (active.data[message.sessionID]) {
						throw new Error('Дождитесь завершения ответа перед сжатием контекста.');
					}
					const payload = await apiPost(this.cliBinary, cwd,
						'/api/session/' + encodeURIComponent(message.sessionID) + '/compact', {});
					if (!payload || !payload.data || payload.data.type !== 'compaction') {
						throw new Error('Сервис не подтвердил запрос на сжатие.');
					}
					this.post({ type: 'compactRequested', sessionID: message.sessionID, ok: true });
				} catch (error) {
					const text = error instanceof Error ? error.message : String(error);
					this.post({ type: 'compactRequested', sessionID: message.sessionID, ok: false, message: text });
				}
				return;
			}


      if (message.type === 'sessionCost' && typeof message.sessionID === 'string') {
        const info = await this.readSessionInfo(message.sessionID);
        this.post({
          type: 'sessionCost',
          sessionID: message.sessionID,
          cost: info.cost,
          tokens: info.tokens,
          title: info.title,
          agent: info.agent,
          model: info.model
        });
        return;
      }

      if (message.type === 'agents') {
        this.post({ type: 'agents', items: await this.readAgents(), defaultAgent: readDefaultAgent() });
        return;
      }

      if (message.type === 'setDefaultModel' && typeof message.providerID === 'string' && typeof message.modelID === 'string') {
        try {
          const model = setDefaultModel(message.providerID, message.modelID);
          await this.applyConfigChange().catch(() => {
            this.pendingReload = true;
          });
          this.post({ type: 'defaultModelSet', ok: true, model, deferred: this.pendingReload });
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          this.post({ type: 'defaultModelSet', ok: false, message: text });
        }
        return;
      }

      if (message.type === 'models') {
        try {
          const items = await this.readModels();
          const defaultModel = await this.readDefaultModelKey();
          this.post({ type: 'models', items, defaultModel });
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          this.post({ type: 'models', items: [], defaultModel: '', message: text });
        }
        return;
      }

      if (message.type === 'setDefaultAgent' && typeof message.agent === 'string') {
        try {
          setDefaultAgent(message.agent);
          await this.applyConfigChange().catch(() => {
            this.pendingReload = true;
          });
          this.post({ type: 'defaultAgentSet', ok: true, agent: message.agent, deferred: this.pendingReload });
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          this.post({ type: 'defaultAgentSet', ok: false, message: text });
        }
        return;
      }

      if (message.type === 'setAgent' && typeof message.sessionID === 'string' && typeof message.agent === 'string') {
        try {
          await this.switchAgent(message.sessionID, message.agent);
          this.post({ type: 'agentChanged', sessionID: message.sessionID, agent: message.agent, ok: true });
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          this.post({ type: 'agentChanged', sessionID: message.sessionID, agent: message.agent, ok: false, message: text });
        }
        return;
      }

      if (message.type === 'recommended') {
        await this.sendRecommended();
        return;
      }

      if (message.type === 'installRecommended' && typeof message.id === 'string') {
        try {
          const result = await this.installRecommended(message.id);
          this.post({
            type: 'recommendedInstalled',
            id: message.id,
            ok: true,
            done: result.done,
            missing: result.missing
          });
          await this.sendRecommended();
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          this.post({ type: 'recommendedInstalled', id: message.id, ok: false, message: text });
        }
        return;
      }

      if (message.type === 'telegramState') {
        try {
          this.post({ type: 'telegramState', ...(await telegramStatus()) });
        } catch (error) {
          this.post({ type: 'telegramState', installed: false, running: false, autostart: false, text: error.message });
        }
        return;
      }

      if (message.type === 'telegramAction' && typeof message.action === 'string') {
        try {
          if (message.action === 'install') {
            installSkill(this.extensionUri, 'telegram');
          }
          const text = await telegramAction(message.action);
          const state = await telegramStatus().catch(() => ({ installed: true, running: false, autostart: false, text: '' }));
          this.post({ type: 'telegramResult', ok: true, action: message.action, text, state });
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          const state = await telegramStatus().catch(() => ({ installed: false, running: false, autostart: false, text: '' }));
          this.post({ type: 'telegramResult', ok: false, action: message.action, text, state });
        }
        return;
      }

      if (message.type === 'telegramInstall') {
        try {
          installSkill(this.extensionUri, 'telegram');
          const text = await telegram.install(telegramHome(), message.token, message.userId);
          const state = await telegramStatus();
          this.post({ type: 'telegramResult', ok: true, action: 'install', text, state });
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          const state = await telegramStatus().catch(() => ({ installed: false, configured: false, running: false, autostart: false, text: '' }));
          this.post({ type: 'telegramResult', ok: false, action: 'install', text, state });
        }
        return;
      }

      if (message.type === 'installSkill' && typeof message.id === 'string') {
        try {
          const target = installSkill(this.extensionUri, message.id);
          this.post({ type: 'skillInstalled', id: message.id, ok: true, path: target });
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          this.post({ type: 'skillInstalled', id: message.id, ok: false, message: text });
        }
        return;
      }

      if (message.type === 'installAgent' && typeof message.id === 'string') {
        try {
          const target = installAgent(this.extensionUri, message.id);
          this.post({ type: 'agentInstalled', id: message.id, ok: true, path: target });
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          this.post({ type: 'agentInstalled', id: message.id, ok: false, message: text });
        }
        return;
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.post({ type: 'embedded-error', message: text });
    }
  }

  handleProxyEvent(event) {
    try {
      const data = event && event.data;
      if (!data || typeof data.type !== 'string' || !data.type.startsWith('session.execution.')) {
        return;
      }
      const match = JSON.stringify(data).match(/ses_[A-Za-z0-9]+/);
      if (!match) {
        return;
      }
      const sessionID = match[0];
      const busy = data.type === 'session.execution.started';
      if (!this.sessionBusy) {
        this.sessionBusy = new Map();
      }
      if (this.sessionBusy.get(sessionID) === busy) {
        return;
      }
      this.sessionBusy.set(sessionID, busy);
      this.post({ type: 'sessionActivity', sessionID, busy, outcome: busy ? '' : data.type.slice('session.execution.'.length) });
      if (!busy && this.pendingReload) {
        const anyBusy = [...this.sessionBusy.values()].some(Boolean);
        if (!anyBusy) {
          this.pendingReload = false;
          this.reloadConfig().catch(() => {
            this.pendingReload = true;
          });
        }
      }
    } catch {
      // Events are advisory; a parse failure must not break the proxy.
    }
  }

  async readSessionInfo(sessionID) {
    try {
      if (this.cliBinary === undefined) {
        this.cliBinary = (await detectCli()).binary;
      }
      const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
      const cwd = folder ? folder.uri.fsPath : undefined;
      const payload = await apiGet(this.cliBinary, cwd, '/api/session/' + encodeURIComponent(sessionID));
      const session = payload && payload.data ? payload.data : payload;
      return {
        cost: Number(session && session.cost) || 0,
        tokens: (session && session.tokens) || null,
        title: session && session.title ? String(session.title) : '',
        agent: session && session.agent ? String(session.agent) : '',
        model: session && session.model
          ? { providerID: String(session.model.providerID || ''), id: String(session.model.id || ''), variant: String(session.model.variant || '') }
          : null
      };
    } catch {
      return { cost: 0, tokens: null, title: '', agent: '', model: null };
    }
  }


  async readModels() {
    if (this.cliBinary === undefined) {
      this.cliBinary = (await detectCli()).binary;
    }
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    const cwd = folder ? folder.uri.fsPath : undefined;
    const payload = await apiGet(this.cliBinary, cwd, '/api/model');
    const list = payload && Array.isArray(payload.data) ? payload.data : [];
    return list
      .filter((item) => item && item.providerID && item.modelID)
      .map((item) => ({
        providerID: String(item.providerID),
        modelID: String(item.modelID),
        name: String(item.name || item.modelID)
      }));
  }

  async readDefaultModelKey() {
    if (this.cliBinary === undefined) {
      this.cliBinary = (await detectCli()).binary;
    }
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    const cwd = folder ? folder.uri.fsPath : undefined;
    const payload = await apiGet(this.cliBinary, cwd, '/api/model/default');
    const item = payload && payload.data ? payload.data : null;
    return item && item.providerID && item.modelID ? item.providerID + '/' + item.modelID : '';
  }

  async readAgents() {    if (this.agents) {
      return this.agents;
    }
    try {
      if (this.cliBinary === undefined) {
        this.cliBinary = (await detectCli()).binary;
      }
      const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
      const cwd = folder ? folder.uri.fsPath : undefined;
      const payload = await apiGet(this.cliBinary, cwd, '/api/agent');
      const list = payload && Array.isArray(payload.data) ? payload.data : [];
      this.agents = list
        .filter((item) => item && item.id && item.mode === 'primary' && !item.hidden)
        .map((item) => ({ id: String(item.id), name: String(item.name || item.id) }));
      return this.agents;
    } catch {
      return [];
    }
  }

  async reloadConfig() {
    if (this.cliBinary === undefined) {
      this.cliBinary = (await detectCli()).binary;
    }
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    await reloadOpencode(this.cliBinary, folder ? folder.uri.fsPath : undefined);
  }

  async applyConfigChange() {
    const busy = await this.anySessionRunning();
    if (busy) {
      this.pendingReload = true;
      return;
    }
    await this.reloadConfig();
  }

  async anySessionRunning() {
    try {
      if (this.cliBinary === undefined) {
        this.cliBinary = (await detectCli()).binary;
      }
      const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
      const cwd = folder ? folder.uri.fsPath : undefined;
      const payload = await apiGet(this.cliBinary, cwd, '/api/session/active');
      const data = payload && payload.data ? payload.data : {};
      return Object.values(data).some((entry) => entry && entry.type === 'running');
    } catch {
      return true;
    }
  }

  async switchAgent(sessionID, agent) {    if (this.cliBinary === undefined) {
      this.cliBinary = (await detectCli()).binary;
    }
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    const cwd = folder ? folder.uri.fsPath : undefined;
    await apiPost(this.cliBinary, cwd, '/api/session/' + encodeURIComponent(sessionID) + '/agent', { agent });
  }

  async runGraphify(sessionID) {
    if (this.cliBinary === undefined) {
      this.cliBinary = (await detectCli()).binary;
    }
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    const cwd = folder ? folder.uri.fsPath : undefined;
    const text = 'Построй граф знаний по текущему проекту через graphify. Если graphify-out уже существует — обнови граф инкрементально (--update), иначе построй заново.';
    await apiPost(this.cliBinary, cwd, '/api/session/' + encodeURIComponent(sessionID) + '/prompt', {
      text: text,
      skills: [{ id: 'graphify' }]
    });
  }

  async sendRecommended() {
    let telegramState = { installed: false, configured: false, running: false, autostart: false, text: '' };
    try {
      telegramState = await telegramStatus();
    } catch (error) {
      telegramState.text = error instanceof Error ? error.message : String(error);
    }
    this.post({ type: 'recommended', items: readRecommended(this.extensionUri), telegram: telegramState });
  }

  async installRecommended(id) {
    const entry = manifestEntry(this.extensionUri, id);
    if (!entry) {
      throw new Error('Пункт не найден: ' + id);
    }
    const setup = entry.setup && typeof entry.setup === 'object' ? entry.setup : {};
    const requires = entry.requires && typeof entry.requires === 'object' ? entry.requires : {};
    const done = [];

    // 1. Внешние зависимости и сам бинарник — по порядку, с перепроверкой PATH.
    for (const step of requirementSteps(entry)) {
      if (step.kind === 'mcp') continue;
      if (!step.command) {
        throw new Error('Для «' + step.title + '» не задана команда установки.');
      }
      this.post({ type: 'recommendedProgress', id: id, text: 'Устанавливаю ' + step.title + '…' });
      await runSetupCommand(step.command);
      if (!binaryPath(step.binary)) {
        throw new Error(step.title + ' установлен, но не найден в PATH. Перезагрузите окно VS Code и нажмите «Обновить».');
      }
      done.push(step.title);
    }

    // 2. MCP-запись в конфиг opencode.
    if (requires.mcp && !hasMcpServer(String(requires.mcp))) {
      if (!setup.mcp || typeof setup.mcp !== 'object') {
        throw new Error('Не задано описание MCP-сервера ' + requires.mcp + '.');
      }
      const definition = JSON.parse(JSON.stringify(setup.mcp));
      if (requires.binary && Array.isArray(definition.command)) {
        const binary = binaryPath(String(requires.binary));
        if (binary) {
          definition.command = definition.command.map((part) => (part === requires.binary ? binary : part));
        }
      }
      addMcpServer(String(requires.mcp), definition);
      await this.applyConfigChange().catch(() => {
        this.pendingReload = true;
      });
      done.push('MCP ' + requires.mcp);
    }

    // 3. Сам рекомендуемый пакет — скилл или агент.
    this.post({ type: 'recommendedProgress', id: id, text: 'Устанавливаю пакет…' });
    if (entry.type === 'agent') {
      installAgent(this.extensionUri, id);
    } else {
      installSkill(this.extensionUri, id);
    }
    done.push(entry.type === 'agent' ? 'агент' : 'скилл');

    return { done: done, missing: unmetRequirements(requires) };
  }

  post(message) {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage(message);
  }

  async checkUpdates() {
    if (this.updating) {
      return;
    }
    this.updating = true;
    const pkg = this.context.extension && this.context.extension.packageJSON;
    const current = this.installedVersion || (pkg ? String(pkg.version || '') : '');
    try {
      this.post({ type: 'updateStatus', state: 'checking', version: current });
      const release = await updates.latestRelease();
      if (!updates.isNewer(release.version, current)) {
        this.post({ type: 'updateStatus', state: 'current', version: current, latest: release.version });
        return;
      }
      this.post({ type: 'updateStatus', state: 'downloading', version: release.version });
      const file = await updates.downloadVsix(release);
      this.post({ type: 'updateStatus', state: 'installing', version: release.version });
      await installVsix(file);
      this.installedVersion = release.version;
      this.post({ type: 'updateStatus', state: 'done', version: release.version });
      const choice = await vscode.window.showInformationMessage(
        'opencode Sidebar обновлён до ' + release.version + '. Перезагрузить окно?',
        'Перезагрузить',
        'Позже'
      );
      if (choice === 'Перезагрузить') {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.post({ type: 'updateStatus', state: 'error', message: text });
      vscode.window.showErrorMessage('Не удалось обновить opencode Sidebar: ' + text);
    } finally {
      this.updating = false;
    }
  }

  async openEmbedded(options = {}) {
    if (this.embedding) {
      return;
    }
    this.embedding = true;
    this.post({ type: 'embedded-starting' });
    try {
      const webUi = await this.ensureWebUi();
      const external = await vscode.env.asExternalUri(vscode.Uri.parse(webUi.url));
      const target = new URL(external.toString(true));
      target.searchParams.set('t', String(Date.now()));
      this.embeddedUrl = target.toString();
      this.post({ type: 'embedded', url: this.embeddedUrl, reloaded: Boolean(options.reloaded) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.post({ type: 'embedded-error', message, installable: Boolean(error && error.installable) });
    } finally {
      this.embedding = false;
    }
  }

  async reloadEmbedded() {
    const webUi = this.webUi;
    this.webUi = null;
    this.embeddedUrl = null;
    if (webUi) {
      try {
        await webUi.close();
      } catch {
        // Start a fresh proxy even if the old one failed to close cleanly.
      }
    }
    await this.openEmbedded({ reloaded: true });
  }

  preferredPort() {
    const ports = this.context.globalState.get(PORT_STATE_KEY, {}) || {};
    const value = ports[scopeHash(workspaceScope())];
    return Number.isInteger(value) && value > 0 ? value : 0;
  }

  rememberPort(port, reused) {
    const key = scopeHash(workspaceScope());
    const ports = { ...(this.context.globalState.get(PORT_STATE_KEY, {}) || {}) };
    if (reused || !ports[key]) {
      ports[key] = port;
      this.context.globalState.update(PORT_STATE_KEY, ports);
    }
  }

  async ensureWebUi() {
    if (this.webUi) {
      return this.webUi;
    }
    if (!this.webUiStarting) {
      this.webUiStarting = (async () => {
        const detected = await detectCli();
        if (!detected.found) {
          const error = new Error('opencode не установлен. Поставьте CLI командой «npm install -g @opencode/cli@latest» или с https://opencode.ai, затем нажмите «Повторить».');
          error.installable = true;
          throw error;
        }
        const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
        const port = this.port || this.preferredPort();
        const webUi = await startOpencodeWebUi({
          binary: detected.binary,
          cwd: folder ? folder.uri.fsPath : undefined,
          port,
          onEvent: (event) => this.handleProxyEvent(event)
        });
        if (this.disposed) {
          await webUi.close();
          throw new Error('Панель уже закрыта.');
        }
        this.port = webUi.port;
        this.rememberPort(webUi.port, webUi.reused);
        this.webUi = webUi;
        return webUi;
      })().finally(() => {
        this.webUiStarting = null;
      });
    }
    return this.webUiStarting;
  }

  async openFullView(url) {
    this.disposed = false;
    const webUi = await this.ensureWebUi();
    const base = webUi.url;
    const target = typeof url === 'string' && url.startsWith(base) ? url : base;
    if (this.fullPanel) {
      this.fullPanel.reveal(vscode.ViewColumn.Active);
      this.fullPanel.webview.postMessage({ type: 'navigate', url: target });
      await this.collapseSidebarForFull();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'opencodeSidebar.full',
      'opencode',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri]
      }
    );
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'opencode.svg');
    panel.webview.html = renderFullHtml(panel.webview, target);
    panel.webview.onDidReceiveMessage((message) => {
      if (message && message.type === 'closeFull') {
        panel.dispose();
      }
    });
    panel.onDidDispose(() => {
      if (this.fullPanel === panel) {
        this.fullPanel = null;
      }
      if (this.fullRestoreSidebar) {
        this.revealSidebar();
        return;
      }
      if (!this.view) {
        this.dispose();
      }
    });
    this.fullPanel = panel;
    await this.collapseSidebarForFull();
  }

  async collapseSidebarForFull() {
    if (!this.view || !this.view.visible) {
      return;
    }
    this.fullRestoreSidebar = true;
    try {
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
    } catch {
      this.fullRestoreSidebar = false;
    }
  }

  async revealSidebar() {
    this.fullRestoreSidebar = false;
    try {
      await vscode.commands.executeCommand('workbench.view.extension.opencodeSidebar');
    } catch {
      try {
        await vscode.commands.executeCommand('workbench.action.focusSideBar');
      } catch {
        // Sidebar may be disabled in this workspace.
      }
    }
    try {
      await vscode.commands.executeCommand('opencodeSidebar.main.focus');
    } catch {
      // Focus command may be unavailable; the sidebar is already open.
    }
  }

  async dispose() {
    this.disposed = true;
    this.embeddedUrl = null;
    if (this.fullPanel) {
      return;
    }
    if (this.webUiStarting) {
      try {
        await this.webUiStarting;
      } catch {
        // Ignore startup errors during disposal.
      }
    }
    const webUi = this.webUi;
    this.webUi = null;
    if (webUi) {
      try {
        await webUi.close();
      } catch {
        // Ignore close errors.
      }
    }
  }
}

function activate(context) {
	const target = path.join(os.homedir(), '.config', 'opencode', 'plugins', 'opencode-sidebar-completion.js');
	try {
		if (fs.existsSync(target)) {
			const content = fs.readFileSync(target, 'utf8');
			if (!content.includes("id: 'opencode-sidebar.completion'")) {
				throw new Error('Неизвестный файл плагина.');
			}
			fs.renameSync(target, target + '.disabled-' + Date.now());
		}
	} catch {
		vscode.window.showErrorMessage('Не удалось отключить старый плагин итогов opencode: opencode-sidebar-completion.js.');
	}
  const provider = new OpencodeViewProvider(context);
  activeProvider = provider;

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('opencodeSidebar.reloadUi', () => provider.reloadEmbedded()),
    vscode.commands.registerCommand('opencodeSidebar.openFull', () => provider.openFullView()),
    vscode.commands.registerCommand('opencodeSidebar.newTab', () => provider.post({ type: 'newTab' })),
    vscode.commands.registerCommand('opencodeSidebar.openTerminal', () => openOpencode(false)),
    vscode.commands.registerCommand('opencodeSidebar.telegramStatus', () => telegramCommand('status')),
    vscode.commands.registerCommand('opencodeSidebar.telegramStart', () => telegramCommand('start')),
    vscode.commands.registerCommand('opencodeSidebar.telegramStop', () => telegramCommand('stop')),
    vscode.commands.registerCommand('opencodeSidebar.telegramRestart', () => telegramCommand('restart')),
    vscode.commands.registerCommand('opencodeSidebar.telegramAutostart', () => telegramCommand('autostart'))
  );
}

async function telegramCommand(action) {
  try {
    const text = String(await telegramAction(action) || '').trim();
    if (text) {
      vscode.window.showInformationMessage(text.split(/\r?\n/).join(' · '));
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage('Telegram-бот: ' + detail);
  }
}

function deactivate() {
  const provider = activeProvider;
  activeProvider = null;
  if (provider) {
    return provider.dispose();
  }
  return undefined;
}

async function openOpencode(newSession) {
  const existing = findOpencodeTerminal();
  if (!newSession && existing) {
    existing.show();
    return;
  }

  const terminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    location: vscode.TerminalLocation.Panel,
    env: { OPENCODE_CALLER: 'vscode' }
  });
  terminal.show();
  terminal.sendText('opencode');
}

function terminalMatchesLocation(terminal) {
  const value = terminal.creationOptions && terminal.creationOptions.location;
  return value === undefined || value === vscode.TerminalLocation.Panel;
}

function findOpencodeTerminal() {
  const terminals = vscode.window.terminals;
  for (let index = terminals.length - 1; index >= 0; index -= 1) {
    const terminal = terminals[index];
    if (terminal.name === TERMINAL_NAME && terminalMatchesLocation(terminal)) {
      return terminal;
    }
  }
  return undefined;
}

function pickBinary(lines) {
  if (process.platform === 'win32') {
    return lines.find((line) => /(^|[\\/])opencode\.exe$/i.test(line)) || '';
  }
  return lines.find((line) => /(^|[\\/])opencode$/i.test(line)) || '';
}

function detectCli() {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/sh');
    const args = isWindows
      ? ['/d', '/c', 'where opencode 2>nul & opencode --version 2>nul']
      : ['-lc', 'command -v opencode 2>/dev/null; opencode --version 2>/dev/null || true'];

    execFile(shell, args, { timeout: 6000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      const output = String(stdout || '').trim();
      if ((error && !output) || !output) {
        resolve({ finding: false, found: false, version: '', binary: '' });
        return;
      }

      const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const binary = pickBinary(lines);
      const versionLine = lines.find((line) => line !== binary && /v?\d+\.\d+\.\d+/.test(line)) || '';
      const versionMatch = versionLine.match(/v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);

      resolve({
        finding: false,
        found: Boolean(binary || versionMatch),
        version: versionMatch ? versionMatch[0].replace(/^v/i, '') : '',
        binary
      });
    });
  });
}

function renderFullHtml(webview, url) {
  const nonce = getNonce();
  const safe = String(url)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; frame-src http: https:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: var(--vscode-editor-background); }
  iframe { display: block; width: 100%; height: 100%; border: 0; }
  .full-back {
    position: fixed; top: 8px; right: 12px; z-index: 10;
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 10px;
    border: 1px solid var(--vscode-button-border, rgba(255, 255, 255, .18));
    border-radius: 5px;
    background: var(--vscode-button-secondaryBackground, rgba(30, 30, 30, .85));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground, #fff));
    font-family: var(--vscode-font-family, sans-serif);
    font-size: 12px; line-height: 16px; cursor: pointer; opacity: .78;
  }
  .full-back:hover { opacity: 1; background: var(--vscode-button-secondaryHoverBackground, rgba(60, 60, 60, .95)); }
  .full-back:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
</style>
</head>
<body>
<iframe id="frame" src="${safe}" title="opencode" allow="clipboard-read; clipboard-write"></iframe>
<button id="full-back" class="full-back" type="button" title="Закрыть полный экран и вернуться в панель">⤡ В панель</button>
<script nonce="${nonce}">
  var vscode = acquireVsCodeApi();
  document.getElementById('full-back').addEventListener('click', function () {
    vscode.postMessage({ type: 'closeFull' });
  });
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (data && data.type === 'navigate' && typeof data.url === 'string') {
      document.getElementById('frame').src = data.url;
    }
  });
</script>
</body>
</html>`;
}

function renderHtml(webview, extensionUri) {
  const nonce = getNonce();
  const panelScript = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'panel.js'));
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}'; img-src ${webview.cspSource} data:; frame-src http: https:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; padding: 0; overflow: hidden; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); background: var(--vscode-sideBar-background); }
  [hidden] { display: none !important; }
  .app { position: fixed; inset: 0; display: flex; flex-direction: column; background: var(--vscode-sideBar-background); }
  .tabbar { display: flex; align-items: center; flex: none; height: 32px; min-height: 32px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
  .tabs { display: flex; align-items: center; flex: 1; min-width: 0; height: 100%; overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; }
  .tab { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; max-width: 180px; height: 26px; margin: 0 2px; padding: 0 6px; border: 0; border-radius: 4px; background: var(--vscode-tab-inactiveBackground, transparent); color: var(--vscode-tab-inactiveForeground, var(--vscode-foreground)); font-family: inherit; font-size: 12px; line-height: 1; cursor: pointer; }
  .tab:hover { background: var(--vscode-tab-hoverBackground, var(--vscode-toolbar-hoverBackground)); }
  .tab.dragging { opacity: .45; cursor: grabbing; }
  .tab.active { background: var(--vscode-tab-activeBackground, var(--vscode-button-background)); color: var(--vscode-tab-activeForeground, var(--vscode-button-foreground)); }
  .tab-title { min-width: 0; max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tab-close { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 15px; height: 15px; border-radius: 3px; font-size: 13px; opacity: .65; }
  .tab-close:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
  .tab-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-charts-green); }
  .tab.busy .tab-dot { background: var(--vscode-charts-yellow); animation: tab-pulse 1.1s ease-in-out infinite; }
  .tab.unread { background: var(--vscode-charts-green); color: #fff; }
  .tab.unread .tab-dot { background: #fff; }
  .tab.unread .tab-close { opacity: .9; }
  .tab.unread:hover { filter: brightness(1.06); }
  @keyframes tab-pulse { 0%, 100% { opacity: .3; transform: scale(.75); } 50% { opacity: 1; transform: scale(1); } }
  .tab-add { flex: none; width: 28px; height: 26px; margin: 0 4px 0 2px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--vscode-foreground); font-family: inherit; font-size: 17px; line-height: 1; cursor: pointer; }
  .tab-add:hover { background: var(--vscode-toolbar-hoverBackground); }
  .tab-add:disabled { opacity: .35; cursor: default; }
  .rec-open { flex: none; width: 26px; height: 26px; margin: 0 2px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--vscode-foreground); font-family: inherit; font-size: 13px; line-height: 1; cursor: pointer; }
  .rec-open:hover { background: var(--vscode-toolbar-hoverBackground); }
  .recommended { position: absolute; top: 32px; right: 0; bottom: 0; left: 0; z-index: 20; display: flex; flex-direction: column; background: var(--vscode-sideBar-background); }
  .rec-head { display: flex; align-items: center; justify-content: space-between; flex: none; padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 12px; font-weight: 600; }
  .rec-close { border: 0; background: transparent; color: var(--vscode-foreground); font-size: 15px; line-height: 1; cursor: pointer; }
  .rec-list { flex: 1; min-height: 0; overflow: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
  .rec-empty { padding: 8px; color: var(--vscode-descriptionForeground); font-size: 12px; }
  .rec-item { display: flex; gap: 8px; padding: 8px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
  .rec-num { flex: none; width: 18px; height: 18px; border-radius: 9px; display: flex; align-items: center; justify-content: center; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 10px; }
  .rec-body { flex: 1; min-width: 0; }
  .rec-name { font-size: 12px; margin-bottom: 2px; }
  .rec-desc { font-size: 11px; line-height: 1.4; color: var(--vscode-descriptionForeground); }
  .rec-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; }
  .rec-foot[hidden] { display: none; }
  .rec-input { flex: 1 1 100%; min-width: 0; padding: 4px 6px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); font-family: inherit; font-size: 11px; }
  .rec-input:disabled { opacity: .6; }
  .rec-hint { margin-top: 4px; font-size: 10px; line-height: 1.35; color: var(--vscode-descriptionForeground); }
  .rec-hint[hidden] { display: none; }
  .rec-prereq { flex: 1 1 100%; font-size: 11px; line-height: 1.4; color: var(--vscode-descriptionForeground); }
  .rec-action { font-family: inherit; font-size: 11px; padding: 3px 9px; border: 1px solid transparent; border-radius: 3px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
  .rec-action:hover { background: var(--vscode-button-hoverBackground); }
  .rec-action:disabled { opacity: .6; cursor: default; }
  .rec-action.rec-secondary { background: transparent; border-color: var(--vscode-button-border, var(--vscode-panel-border)); color: var(--vscode-foreground); }
  .rec-action.rec-secondary:hover { background: var(--vscode-toolbar-hoverBackground); }
  .rec-status { min-width: 0; font-size: 11px; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
  .rec-status.ok { color: var(--vscode-charts-green); }
  .rec-status.warn { color: var(--vscode-charts-yellow); }
  .rec-status.fail { color: var(--vscode-errorForeground); }
  .rec-dep { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; padding: 6px; border: 1px dashed var(--vscode-panel-border); border-radius: 4px; }
  .rec-dep[hidden] { display: none; }
  .rec-dep-text { flex: 1 1 100%; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .rec-wrap { flex-wrap: wrap; }
  .rec-telegram-status { margin-top: 6px; font-size: 11px; line-height: 1.4; color: var(--vscode-descriptionForeground); white-space: pre-wrap; overflow-wrap: anywhere; }
  .rec-telegram-status.ok { color: var(--vscode-charts-green); }
  .session-cost { flex: none; max-width: 96px; margin: 0 2px; padding: 2px 7px; border-radius: 9px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 11px; line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: default; }
  .agent-select { flex: none; max-width: 150px; height: 20px; padding: 0 2px; border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 4px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); font-family: inherit; font-size: 11px; }
  .agent-select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .model-select { max-width: 150px; }
  .agentbar { display: flex; align-items: center; gap: 6px; flex: none; height: 28px; padding: 0 8px; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); position: relative; z-index: 12; }
	.agentbar { overflow: hidden; }
	.agentbar-group { display: flex; align-items: center; gap: 6px; flex: 1 1 auto; min-width: 0; overflow-x: auto; scrollbar-width: thin; }
	.agentbar-btn { flex-shrink: 0; }
  .agentbar-label { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .agentbar-btn { height: 20px; padding: 0 8px; border: 1px solid transparent; border-radius: 4px; background: var(--vscode-button-secondaryBackground, var(--vscode-button-background)); color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground)); font-family: inherit; font-size: 11px; line-height: 1; cursor: pointer; }
  .agentbar-btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
  .agentbar-btn:disabled { opacity: .5; cursor: default; }
  .update-btn { margin-left: auto; padding: 0 6px; font-size: 13px; }
  .update-btn.ok { color: var(--vscode-charts-green); }
  .update-btn.warn { color: var(--vscode-charts-yellow); }
  .update-btn.fail { color: var(--vscode-errorForeground); }
  .panes { position: relative; flex: 1; min-height: 0; }
  .pane { position: absolute; inset: 0; display: none; }
  .pane.active { display: flex; }
  .pane iframe { flex: 1; width: 100%; height: 100%; min-height: 0; border: 0; background: var(--vscode-editor-background); }
  .overlay { position: absolute; inset: 0; z-index: 10; display: flex; align-items: center; justify-content: center; padding: 16px; background: var(--vscode-sideBar-background); color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.45; text-align: center; }
  .error { flex-direction: column; gap: 12px; color: var(--vscode-errorForeground); }
  .error-text { max-width: 100%; overflow-wrap: anywhere; }
  .retry { font-family: inherit; font-size: 12px; padding: 6px 12px; border: 1px solid transparent; border-radius: 4px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
  .overlay.error { flex-wrap: wrap; gap: 8px; }
  .retry:hover { background: var(--vscode-button-hoverBackground); }
  .retry:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .session-back { flex: none; width: 24px; height: 24px; margin: 0 0 0 4px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--vscode-foreground); font-family: inherit; font-size: 15px; line-height: 1; cursor: pointer; }
  .session-back:hover { background: var(--vscode-toolbar-hoverBackground); }
  .session-back:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
</style>
</head>
<body>
<div class="app">
  <div id="tabbar" class="tabbar">
    <button id="session-back" class="session-back" title="К списку сессий" hidden>←</button>
    <div id="tabs" class="tabs">
      <button id="tab-add" class="tab-add" title="Новая вкладка (Ctrl+Shift+T)" disabled>+</button>
    </div>
    <span id="session-cost" class="session-cost" hidden></span>
    <button id="full-open" class="rec-open" title="Открыть на весь экран">⤢</button>
    <button id="rec-open" class="rec-open" title="Рекомендуемое">★</button>
  </div>
  <div id="panes" class="panes"></div>
  <div id="agent-bar" class="agentbar">
    <div id="agent-controls" class="agentbar-group" hidden>
      <span class="agentbar-label">Агент</span>
      <select id="agent-select" class="agent-select" title="Агент сессии"></select>
      <select id="model-select" class="agent-select model-select" title="Модель по умолчанию"></select>
      <button id="graphify-btn" class="agentbar-btn" title="Построить или обновить граф знаний по проекту" hidden>Graphify</button>
		  <button id="compact-btn" class="agentbar-btn" title="Сжать контекст текущей сессии. Часть деталей может потеряться.">Сжать контекст</button>
    </div>
    <button id="update-btn" class="agentbar-btn update-btn" title="Проверить обновления расширения">⬆</button>
  </div>
  <div id="rec-panel" class="recommended" hidden>
    <div class="rec-head">
      <span>Рекомендуемое</span>
      <button id="rec-close" class="rec-close" title="Закрыть">×</button>
    </div>
    <div id="rec-list" class="rec-list"></div>
  </div>
  <div id="embedded-loading" class="overlay">Запускаю opencode…</div>
  <div id="embedded-error" class="overlay error" hidden>
    <div id="embedded-error-text" class="error-text"></div>
    <button id="embedded-retry" class="retry">Повторить</button>
    <button id="embedded-install" class="retry" hidden>Установить opencode</button>
  </div>
</div>
<script nonce="${nonce}" src="${panelScript}"></script>
</body>
</html>`;
}

function getNonce() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let index = 0; index < 32; index += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}

module.exports = { activate, deactivate, readRecommended, addMcpServer, installSkill };
