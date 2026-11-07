'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function loadExtension(pluginContent, options = {}) {
	let provider;
	let renamed = false;
	const errors = [];
	const messages = [];
	const requests = [];
	const commands = [];
	const registeredCommands = {};
	const responses = { active: { data: {} }, compact: { data: { type: 'compaction' } } };
	const opened = [];
	const vscode = {
		workspace: { workspaceFolders: [{ uri: { fsPath: 'workspace' } }] },
		window: {
			registerWebviewViewProvider(id, value) { provider = value; },
			showErrorMessage(message) { errors.push(message); },
			async showInformationMessage() { return 'Позже'; }
		},
		commands: {
			registerCommand(name, handler) { registeredCommands[name] = handler; },
			async executeCommand(command) { commands.push(command); }
		},
		Uri: {
			joinPath(uri, ...parts) { return parts.join('/'); },
			file(value) { return { fsPath: value }; },
			parse(value) { return { toString() { return value; } }; }
		},
		env: {
			async openExternal(uri) { opened.push(uri.toString()); }
		}
	};
	const modules = {
		vscode,
		fs: {
			existsSync() { return pluginContent !== undefined; },
			readFileSync() { return pluginContent; },
			renameSync(from, to) {
				assert.match(from, /opencode-sidebar-completion\.js$/);
				assert.match(to, /\.js\.disabled-\d+$/);
				renamed = true;
			}
		},
		'./telegram': require('../telegram'),
		'./updates': options.updates || require('../updates'),
		'./webui': {
			async apiGet(binary, cwd, endpoint) { requests.push(endpoint); return responses.active; },
			async apiPost(binary, cwd, endpoint, body) { requests.push({ endpoint, body }); return responses.compact; }
		}
	};
	const sandbox = { module: { exports: {} }, require: (id) => modules[id] || require(id) };
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8'), sandbox);
	sandbox.module.exports.activate({
		extensionUri: { fsPath: 'extension' },
		subscriptions: [],
		extension: { packageJSON: { version: options.version || '0.0.0' } }
	});
	provider.cliBinary = '';
	provider.view = { webview: { postMessage(message) { messages.push(message); } } };
	return { provider, responses, requests, messages, errors, renamed, commands, registeredCommands, opened, renderFullHtml: sandbox.module.exports.renderFullHtml };
}

test('старый плагин отключается с сохранением резервной копии', () => {
	const state = loadExtension("export default { id: 'opencode-sidebar.completion' }");
	assert.equal(state.renamed, true);
	assert.deepEqual(state.errors, []);
});

test('отсутствующий или неизвестный плагин не удаляется', () => {
	assert.equal(loadExtension().renamed, false);
	const unknown = loadExtension('Пользовательский файл');
	assert.equal(unknown.renamed, false);
	assert.equal(unknown.errors.length, 1);
});

test('сжатие отправляет штатный запрос для выбранной сессии', async () => {
	const state = loadExtension();
	await state.provider.onMessage({ type: 'compact', sessionID: 'ses_test' });
	assert.equal(state.requests[0], '/api/session/active');
	assert.equal(state.requests[1].endpoint, '/api/session/ses_test/compact');
	assert.equal(JSON.stringify(state.requests[1].body), '{}');
	assert.equal(state.messages[0].type, 'compactRequested');
	assert.equal(state.messages[0].ok, true);
});

test('во время ответа сжатие не запускается', async () => {
	const state = loadExtension();
	state.responses.active = { data: { ses_test: { type: 'running' } } };
	await state.provider.onMessage({ type: 'compact', sessionID: 'ses_test' });
	assert.equal(state.requests.length, 1);
	assert.equal(state.messages[0].ok, false);
});

test('нет подтверждения сервиса — нет ложного сообщения об успехе', async () => {
	const state = loadExtension();
	state.responses.compact = {};
	await state.provider.onMessage({ type: 'compact', sessionID: 'ses_test' });
	assert.equal(state.messages[0].ok, false);
});

test('панель содержит «Сжать контекст» и не содержит карточку итогов', () => {
	const state = loadExtension();
	const webview = { cspSource: 'test:', asWebviewUri(value) { return value; }, onDidReceiveMessage() {} };
	state.provider.resolveWebviewView({ webview, visible: true, onDidChangeVisibility() {}, onDidDispose() {} });
	assert.match(webview.html, /id="compact-btn"[^>]*>Сжать контекст<\/button>/);
	assert.match(webview.html, /id="update-btn"[^>]*title="Проверить обновления расширения"/);
	assert.doesNotMatch(webview.html, /session-result/);
	const panel = fs.readFileSync(path.join(__dirname, '..', 'media', 'panel.js'), 'utf8');
	assert.doesNotMatch(panel, /sessionResult|renderResult|requestResult|resultRequest/);
	assert.match(panel, /telegramInstall/);
	assert.match(panel, /rec-input/);
	assert.match(panel, /rec-prereq/);
	assert.match(panel, /full-open/);
	assert.match(panel, /openFull/);
	assert.doesNotMatch(panel, /buttons\.install/);
	const extension = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
	assert.match(extension, /type === 'closeFull'/);
	assert.match(extension, /workbench\.action\.closeSidebar/);
	assert.match(extension, /full-back/);
});

test('полный экран содержит те же элементы управления без перекрывающей кнопки', async () => {
	const state = loadExtension();
	const webview = { cspSource: 'test:', asWebviewUri(value) { return value; } };
	const html = state.renderFullHtml(webview, { fsPath: 'extension' }, 'http://localhost:1234/server/a/session/ses_test?x=1&y=2');
	assert.match(html, /data-full="true" data-initial-url="http:\/\/localhost:1234\/server\/a\/session\/ses_test\?x=1&amp;y=2"/);
	for (const id of ['rec-open', 'rec-panel', 'agent-select', 'model-select', 'graphify-btn', 'update-btn', 'full-back']) {
		assert.match(html, new RegExp('id="' + id + '"'));
	}
	assert.match(html, /<script[^>]*src="[^"]*panel\.js"/);
	assert.match(html, /id="tab-add"[^>]*disabled>\+<\/button>/);
	assert.match(html, /<div id="tabbar"[\s\S]*id="full-back"[\s\S]*<div id="panes"/);
	assert.doesNotMatch(html, /\.full-back\s*\{[^}]*position:\s*fixed/);
	const fullMessages = [];
	state.provider.fullPanel = { webview: { postMessage(message) { fullMessages.push(message); } } };
	await state.provider.onMessage({ type: 'capabilities' });
	assert.equal(fullMessages[0].type, 'capabilities');
	assert.equal(state.messages[0].type, 'capabilities');
});

test('команда новой вкладки отправляется активному полному экрану, а не скрытой боковой панели', () => {
	const state = loadExtension();
	const fullMessages = [];
	state.provider.fullPanel = { active: true, webview: { postMessage(message) { fullMessages.push(message); } } };
	state.registeredCommands['opencodeSidebar.newTab']();
	assert.deepEqual(fullMessages.map((message) => message.type), ['newTab']);
	assert.equal(state.messages.length, 0);
	state.provider.fullPanel.active = false;
	state.registeredCommands['opencodeSidebar.newTab']();
	assert.equal(state.messages[0].type, 'newTab');
});

test('ссылки из web-UI открываются в системном браузере', async () => {
	const state = loadExtension();
	await state.provider.onMessage({ type: 'openExternal', url: 'https://auth.openai.com/authorize?client_id=1' });
	assert.deepEqual(state.opened, ['https://auth.openai.com/authorize?client_id=1']);
	await state.provider.onMessage({ type: 'openExternal', url: 'javascript:alert(1)' });
	assert.equal(state.opened.length, 1);
	const webui = fs.readFileSync(path.join(__dirname, '..', 'webui.js'), 'utf8');
	assert.match(webui, /opencode-sidebar-open-external/);
	assert.match(webui, /window\.open=function/);
	const panel = fs.readFileSync(path.join(__dirname, '..', 'media', 'panel.js'), 'utf8');
	assert.match(panel, /type: 'openExternal'/);
	const extension = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
	assert.match(extension, /env\.openExternal/);
	assert.match(extension, /this\.onMessage\(message\)/);
});

test('сравнение версий считает новые релизы новее', () => {
	const updates = require('../updates');
	assert.equal(updates.isNewer('0.9.25', '0.9.24'), true);
	assert.equal(updates.isNewer('0.9.24', '0.9.24'), false);
	assert.equal(updates.isNewer('0.9.9', '0.9.24'), false);
	assert.equal(updates.isNewer('0.10.0', '0.9.24'), true);
	assert.equal(updates.isNewer('v1.0.0', '0.9.25'), true);
	assert.equal(updates.isNewer('', '0.9.25'), false);
});

test('кнопка обновления скачивает и ставит новый релиз', async () => {
	const state = loadExtension(undefined, {
		version: '0.9.24',
		updates: {
			latestRelease: async () => ({
				version: '0.9.25',
				name: 'opencode-sidebar-0.9.25.vsix',
				url: 'https://example.test/opencode-sidebar-0.9.25.vsix'
			}),
			isNewer: () => true,
			downloadVsix: async () => '/tmp/opencode-sidebar-0.9.25.vsix',
			installWithCli: async () => { throw new Error('CLI не должен использоваться'); }
		}
	});
	await state.provider.onMessage({ type: 'checkUpdates' });
	assert.deepEqual(
		state.messages.filter((message) => message.type === 'updateStatus').map((message) => message.state),
		['checking', 'downloading', 'installing', 'done']
	);
	assert.ok(state.commands.includes('workbench.extensions.installExtension'));
});

test('при актуальной версии установка не запускается', async () => {
	const state = loadExtension(undefined, {
		version: '0.9.25',
		updates: {
			latestRelease: async () => ({ version: '0.9.25', name: 'opencode-sidebar-0.9.25.vsix' }),
			isNewer: () => false
		}
	});
	await state.provider.onMessage({ type: 'checkUpdates' });
	assert.deepEqual(
		state.messages.filter((message) => message.type === 'updateStatus').map((message) => message.state),
		['checking', 'current']
	);
	assert.equal(state.commands.length, 0);
});

function loadRecommended(manifest, prepare) {	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-rec-'));
	const extension = path.join(root, 'extension');
	fs.mkdirSync(path.join(extension, 'skills'), { recursive: true });
	fs.writeFileSync(path.join(extension, 'skills', 'manifest.json'), JSON.stringify({ skills: manifest }));
	const home = path.join(root, 'home');
	fs.mkdirSync(home, { recursive: true });
	if (prepare) prepare({ root, extension, home });
	const sandbox = {
		module: { exports: {} },
		process,
		require: (id) => {
			if (id === 'vscode') return { workspace: { workspaceFolders: [] } };
			if (id === 'os') return Object.assign({}, os, { homedir: () => home });
			if (id.startsWith('./')) return require(path.join(__dirname, '..', id));
			return require(id);
		}
	};
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8'), sandbox);
	return { root, extension, home, readRecommended: sandbox.module.exports.readRecommended, addMcpServer: sandbox.module.exports.addMcpServer, installSkill: sandbox.module.exports.installSkill };
}

function installSkillFiles(home, id) {
	const dir = path.join(home, '.config', 'opencode', 'skills', id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'SKILL.md'), '# ' + id);
}

test('скилл без драйвера и MCP не считается готовым', () => {
	const state = loadRecommended(
		[{
			id: 'cua-driver',
			requires: { binary: 'cua-driver-not-installed-xyz', mcp: 'cua-driver' },
			setup: { binary: { command: 'true' }, mcp: { type: 'local', command: ['cua-driver', 'mcp'] } }
		}],
		({ home }) => installSkillFiles(home, 'cua-driver')
	);
	const item = state.readRecommended({ fsPath: state.extension })[0];
	assert.equal(item.installed, true);
	assert.equal(item.ready, false);
	assert.equal(item.fixable, true);
	assert.equal(item.missing.join(' | '), 'не найден cua-driver-not-installed-xyz | нет MCP cua-driver в opencode.json');
});

test('без setup недостающие зависимости не чинятся автоматически', () => {
	const state = loadRecommended(
		[{ id: 'cua-driver', requires: { binary: 'cua-driver-not-installed-xyz' } }],
		({ home }) => installSkillFiles(home, 'cua-driver')
	);
	const item = state.readRecommended({ fsPath: state.extension })[0];
	assert.equal(item.fixable, false);
});

test('план установки включает внешние зависимости по порядку', () => {
	const state = loadRecommended([{
		id: 'graphify',
		requires: { binary: 'graphify-not-installed-xyz' },
		setup: {
			prerequisites: [{ title: 'uv', binary: 'uv-not-installed-xyz', command: 'true' }],
			binary: { command: 'true' }
		}
	}], null);
	const item = state.readRecommended({ fsPath: state.extension })[0];
	assert.equal(item.installed, false);
	assert.equal(item.fixable, true);
	assert.equal(item.plan.join(' | '), 'uv | graphify-not-installed-xyz');
	assert.equal(item.missing.join(' | '), 'не найден graphify-not-installed-xyz');
});

test('панель предлагает установить зависимости перед пакетом', () => {
	const panel = fs.readFileSync(path.join(__dirname, '..', 'media', 'panel.js'), 'utf8');
	assert.match(panel, /installRecommended/);
	assert.match(panel, /Установить всё/);
	assert.match(panel, /rec-dep/);
});

test('скилл с драйвером и MCP считается установленным', () => {
	const state = loadRecommended(
		[{ id: 'cua-driver', requires: { binary: 'node', mcp: 'cua-driver' } }],
		({ home }) => {
			installSkillFiles(home, 'cua-driver');
			fs.writeFileSync(
				path.join(home, '.config', 'opencode', 'opencode.json'),
				JSON.stringify({ mcp: { servers: { 'cua-driver': { type: 'local', command: ['cua-driver', 'mcp'] } } } })
			);
		}
	);
	const item = state.readRecommended({ fsPath: state.extension })[0];
	assert.equal(item.ready, true);
	assert.equal(item.missing.length, 0);
});

test('скилл без требований считается установленным по файлам', () => {
	const state = loadRecommended([{ id: 'find-skills' }], ({ home }) => installSkillFiles(home, 'find-skills'));
	const item = state.readRecommended({ fsPath: state.extension })[0];
	assert.equal(item.ready, true);
});

test('пункт типа mcp считается установленным по записи в конфиге', () => {
	const entry = {
		id: 'context7',
		type: 'mcp',
		requires: { mcp: 'context7' },
		setup: { mcp: { type: 'remote', url: 'https://mcp.context7.com/mcp', enabled: true } }
	};
	const missing = loadRecommended([entry], null);
	const before = missing.readRecommended({ fsPath: missing.extension })[0];
	assert.equal(before.installed, false);
	assert.equal(before.fixable, true);
	assert.equal(before.plan.join(' | '), 'MCP context7');
	assert.equal(before.ready, false);

	const withConfig = loadRecommended([entry], ({ home }) => {
		fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(home, '.config', 'opencode', 'opencode.json'),
			JSON.stringify({ mcp: { context7: { type: 'remote', url: 'https://mcp.context7.com/mcp' } } })
		);
	});
	const after = withConfig.readRecommended({ fsPath: withConfig.extension })[0];
	assert.equal(after.installed, true);
	assert.equal(after.ready, true);
	assert.equal(after.missing.length, 0);
	// Скилл-файлов у mcp-пункта нет: установка не должна их требовать.
	assert.equal(fs.existsSync(path.join(withConfig.home, '.config', 'opencode', 'skills', 'context7')), false);
});

test('в манифесте есть Context7 как MCP-пункт', () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'skills', 'manifest.json'), 'utf8'));
	const entry = manifest.skills.find((item) => item.id === 'context7');
	assert.ok(entry);
	assert.equal(entry.type, 'mcp');
	assert.equal(entry.requires.mcp, 'context7');
	assert.equal(entry.setup.mcp.type, 'remote');
	assert.equal(entry.setup.mcp.url, 'https://mcp.context7.com/mcp');
});

test('MCP-сервер добавляется в mcp.servers с резервной копией', () => {
	const state = loadRecommended([], ({ home }) => {
		fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(home, '.config', 'opencode', 'opencode.json'),
			JSON.stringify({ mcp: { servers: { obscura: { type: 'local', command: ['obscura', 'mcp'] } } } })
		);
	});
	const file = path.join(state.home, '.config', 'opencode', 'opencode.json');
	state.addMcpServer('cua-driver', { type: 'local', command: ['cua-driver', 'mcp'] });
	const config = JSON.parse(fs.readFileSync(file, 'utf8'));
	assert.deepEqual(Object.keys(config.mcp.servers).sort(), ['cua-driver', 'obscura']);
	const backups = fs.readdirSync(path.join(state.home, '.config', 'opencode')).filter((name) => name.startsWith('opencode.json.bak-'));
	assert.equal(backups.length, 1);
});

test('MCP-сервер создаёт opencode.json, если файла ещё нет', () => {
	const state = loadRecommended([], null);
	assert.equal(fs.existsSync(path.join(state.home, '.config', 'opencode', 'opencode.json')), false);
	const file = state.addMcpServer('cua-driver', { type: 'local', command: ['cua-driver', 'mcp'] });
	assert.equal(file, path.join(state.home, '.config', 'opencode', 'opencode.json'));
	const config = JSON.parse(fs.readFileSync(file, 'utf8'));
	assert.deepEqual(config.mcp.servers['cua-driver'], { type: 'local', command: ['cua-driver', 'mcp'] });
	const backups = fs.readdirSync(path.join(state.home, '.config', 'opencode')).filter((name) => name.startsWith('opencode.json.bak-'));
	assert.equal(backups.length, 0);
});

test('установка opencode использует официальный установщик без npm', () => {
	const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
	assert.match(source, /curl -fsSL https:\/\/opencode\.ai\/v2\/install \| bash/);
	assert.doesNotMatch(source, /npm install -g @opencode\/cli/);
});

test('рабочая папка добавляется в проекты web-UI без повторного выбора', () => {
	const source = fs.readFileSync(path.join(__dirname, '..', 'webui.js'), 'utf8');
	assert.match(source, /registerLocation/);
	assert.match(source, /usedProjectIDs/);
	assert.match(source, /lastProjectID/);
});

test('graphify и find-skills устанавливаются через приложение', () => {
	for (const id of ['graphify', 'find-skills']) {
		const state = loadRecommended([{ id }]);
		const target = state.installSkill({ fsPath: path.join(__dirname, '..') }, id);
		assert.equal(target, path.join(state.home, '.config', 'opencode', 'skills', id));
		assert.equal(fs.existsSync(path.join(target, 'SKILL.md')), true);
		if (id === 'graphify') {
			assert.equal(fs.existsSync(path.join(target, 'references', 'query.md')), true);
		}
		const item = state.readRecommended({ fsPath: state.extension })[0];
		assert.equal(item.installed, true);
	}
});

test('учётные данные Telegram пишутся в .env с правами 600', () => {
	const telegram = require('../telegram');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-tg-'));
	const previous = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = dir;
	try {
		const token = '123456:abcdefghijklmnopqrstuvwxyzABCDE';
		telegram.writeCredentials(token, '123456789');
		const file = path.join(dir, 'opencode-telegram-bot', '.env');
		const body = fs.readFileSync(file, 'utf8');
		assert.match(body, /TELEGRAM_BOT_TOKEN=123456:/);
		assert.match(body, /TELEGRAM_ALLOWED_USER_ID=123456789/);
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		assert.throws(() => telegram.validateCredentials('плохой', '123'), /Токен/);
		assert.throws(() => telegram.validateCredentials(token, '12a'), /ID/);
	} finally {
		if (previous === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = previous;
		}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('неудачный поиск CLI не кэшируется навсегда', async () => {	if (process.platform === 'win32') {
		return;
	}
	const telegramPath = require.resolve('../telegram');
	const telegram = require(telegramPath);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-tg-'));
	const bin = path.join(dir, 'bin');
	const root = path.join(dir, 'root');
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\n[ "$1" = root ] && echo "$FAKE_ROOT"\n', { mode: 0o755 });
	const previousPath = process.env.PATH;
	const previousRoot = process.env.FAKE_ROOT;
	process.env.PATH = bin + path.delimiter + previousPath;
	process.env.FAKE_ROOT = root;
	try {
		const home = path.join(dir, 'home');
		const before = await telegram.status(home);
		assert.equal(before.installed, false);
		const cli = path.join(root, '@grinev', 'opencode-telegram-bot', 'dist', 'cli.js');
		fs.mkdirSync(path.dirname(cli), { recursive: true });
		fs.writeFileSync(cli, 'console.log("Service status: running");\n');
		const after = await telegram.status(home);
		assert.equal(after.installed, true);
	} finally {
		process.env.PATH = previousPath;
		if (previousRoot === undefined) {
			delete process.env.FAKE_ROOT;
		} else {
			process.env.FAKE_ROOT = previousRoot;
		}
		delete require.cache[telegramPath];
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('проверка версии Node учитывает 22.14', () => {
	const telegram = require('../telegram');
	assert.equal(telegram.versionAtLeast('v22.14.0', 22, 14), true);
	assert.equal(telegram.versionAtLeast('v24.1.0', 22, 14), true);
	assert.equal(telegram.versionAtLeast('v22.13.9', 22, 14), false);
	assert.equal(telegram.versionAtLeast('', 22, 14), false);
});
