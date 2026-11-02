'use strict';
(function () {
    const vscode = acquireVsCodeApi();
    window.addEventListener('error', function (event) {
      try {
        vscode.postMessage({ type: 'webviewError', message: String(event.message) + ' @' + event.lineno + ':' + event.colno });
      } catch (error) {
        document.body.setAttribute('data-error', String(event.message));
      }
    });
    const tabsEl = document.getElementById('tabs');
    const panesEl = document.getElementById('panes');
    const addBtn = document.getElementById('tab-add');
    const loading = document.getElementById('embedded-loading');
    const errorBox = document.getElementById('embedded-error');
    const errorText = document.getElementById('embedded-error-text');
    const retry = document.getElementById('embedded-retry');
    const installOpencode = document.getElementById('embedded-install');
    const sessionBack = document.getElementById('session-back');
    const costEl = document.getElementById('session-cost');
    const agentSelect = document.getElementById('agent-select');
    const agentBar = document.getElementById('agent-bar');
    const graphifyBtn = document.getElementById('graphify-btn');
	const compactBtn = document.getElementById('compact-btn');
    const modelSelect = document.getElementById('model-select');
    const recOpen = document.getElementById('rec-open');
    const fullOpen = document.getElementById('full-open');
    const recPanel = document.getElementById('rec-panel');
    const recClose = document.getElementById('rec-close');
    const recList = document.getElementById('rec-list');

    let baseUrl = '';
    let tabs = [];
    let activeId = null;
    let nextId = 1;
    let loadTimer = null;
    let draggedId = null;

    function startLoading(text) {
      errorBox.hidden = true;
      loading.hidden = false;
      loading.textContent = text;
      if (loadTimer) {
        clearTimeout(loadTimer);
      }
      loadTimer = setTimeout(function () {
        if (!loading.hidden) {
          showError('opencode не загрузился за 20 секунд. Попробуйте ещё раз.');
        }
      }, 20000);
    }

    function stopLoading() {
      if (loadTimer) {
        clearTimeout(loadTimer);
        loadTimer = null;
      }
      loading.hidden = true;
    }

    function showError(text, installable) {
      stopLoading();
      errorBox.hidden = false;
      errorText.textContent = text || 'Не удалось открыть opencode.';
      installOpencode.hidden = !installable;
    }

    function normalizeBase(url) {
      try {
        const value = new URL(url);
        value.pathname = '/';
        value.search = '';
        value.hash = '';
        return value.toString();
      } catch (error) {
        return '';
      }
    }

    function withTimestamp(url) {
      try {
        const value = new URL(url);
        value.searchParams.set('t', Date.now() + '-' + String(nextId));
        return value.toString();
      } catch (error) {
        return url;
      }
    }

    function activeTab() {
      for (const tab of tabs) {
        if (tab.id === activeId) {
          return tab;
        }
      }
      return null;
    }

    function updateSessionBack() {
      const tab = activeTab();
      if (!tab) {
        sessionBack.hidden = true;
        return;
      }
      sessionBack.hidden = !(tab.route.indexOf('/server/') !== -1 && tab.route.indexOf('/session/') !== -1);
    }

    function sessionIdOf(tab) {
      const match = String(tab.route || '').match(/\/session\/([^/?#]+)/);
      return match ? match[1] : '';
    }

    function formatCost(value) {
      return '$' + (value >= 0.01 ? value.toFixed(2) : value.toFixed(4));
    }

    function formatTokens(value) {
      const number = Number(value) || 0;
      if (number >= 1000000) {
        return (number / 1000000).toFixed(1) + 'M';
      }
      if (number >= 1000) {
        return (number / 1000).toFixed(1) + 'k';
      }
      return String(number);
    }

    function renderCost(tab) {
      if (!tab) {
        costEl.hidden = true;
        return;
      }
      const cost = Number(tab.cost) || 0;
      if (tab.id !== activeId || cost <= 0) {
        costEl.hidden = true;
        return;
      }
      const tokens = tab.tokens || {};
      const cache = tokens.cache || {};
      const parts = [
        'Стоимость сессии: ' + formatCost(cost),
        'вход ' + formatTokens(tokens.input),
        'выход ' + formatTokens(tokens.output),
        'кэш ' + formatTokens(cache.read)
      ];
      costEl.textContent = formatCost(cost);
      costEl.title = parts.join(' · ');
      costEl.hidden = false;
    }

    function requestCost(tab) {
      if (!tab) {
        return;
      }
      const sessionID = sessionIdOf(tab);
      if (!sessionID) {
        renderCost(null);
        return;
      }
      vscode.postMessage({ type: 'sessionCost', sessionID: sessionID });
    }

    function updateTabState(tab) {
      const showDot = Boolean(tab.busy || tab.unread);
      tab.tabEl.classList.toggle('busy', Boolean(tab.busy));
      tab.tabEl.classList.toggle('unread', Boolean(tab.unread));
      if (tab.dotEl) {
        tab.dotEl.hidden = !showDot;
      }
		if (tab.id === activeId) {
			compactBtn.disabled = Boolean(tab.busy || tab.compactPending);
		}
    }

	compactBtn.addEventListener('click', function () {
		const tab = activeTab();
		if (!tab || !sessionIdOf(tab) || tab.busy || tab.compactPending) {
			return;
		}
		tab.compactPending = true;
		compactBtn.disabled = true;
		compactBtn.title = 'Отправляю запрос на сжатие…';
		vscode.postMessage({ type: 'compact', sessionID: sessionIdOf(tab) });
	});

    let agentsLoaded = false;

    function loadAgents() {
      if (agentsLoaded) {
        return;
      }
      agentsLoaded = true;
      vscode.postMessage({ type: 'agents' });
    }

    function renderAgents(items) {
      const current = agentSelect.value;
      agentSelect.textContent = '';
      (items || []).forEach(function (item) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.name;
        agentSelect.appendChild(option);
      });
      if (current) {
        agentSelect.value = current;
      }
    }

    function updateAgentUi(tab) {
      const sessionID = tab ? sessionIdOf(tab) : '';
      if (!sessionID) {
        agentBar.hidden = true;
        return;
      }
      loadAgents();
      loadModels();
      agentBar.hidden = false;
      if (tab.agent) {
        agentSelect.value = tab.agent;
      }
      agentSelect.title = 'Агент сессии: ' + (tab.agent || 'по умолчанию');
      updateDefaultButton();
    }

    let defaultAgent = '';

    function updateDefaultButton() {
      const current = agentSelect.value;
      const isDefault = Boolean(defaultAgent) && current === defaultAgent;
      agentSelect.title = 'Агент сессии: ' + (current || '—') + (isDefault ? ' · по умолчанию' : '');
    }

    let modelsLoaded = false;

    function loadModels() {
      if (modelsLoaded) {
        return;
      }
      modelsLoaded = true;
      vscode.postMessage({ type: 'models' });
    }

    function renderModels(items, defaultModel) {
      modelSelect.textContent = '';
      (items || []).forEach(function (item) {
        const option = document.createElement('option');
        option.value = item.providerID + '/' + item.modelID;
        option.textContent = item.name;
        modelSelect.appendChild(option);
      });
      if (defaultModel) {
        modelSelect.value = defaultModel;
        modelSelect.title = 'Модель по умолчанию: ' + defaultModel;
      }
    }

    modelSelect.addEventListener('change', function () {
      const value = String(modelSelect.value || '');
      const index = value.indexOf('/');
      if (index <= 0) {
        return;
      }
      const providerID = value.slice(0, index);
      const modelID = value.slice(index + 1);
      modelSelect.title = 'Записываю модель по умолчанию: ' + value;
      vscode.postMessage({ type: 'setDefaultModel', providerID, modelID });
    });

    graphifyBtn.addEventListener('click', function () {
      const tab = activeTab();
      const sessionID = tab ? sessionIdOf(tab) : '';
      if (!sessionID) {
        return;
      }
      graphifyBtn.disabled = true;
      graphifyBtn.title = 'Запускаю graphify…';
      vscode.postMessage({ type: 'graphify', sessionID: sessionID });
    });

    agentSelect.addEventListener('change', function () {
      const tab = activeTab();
      const sessionID = tab ? sessionIdOf(tab) : '';
      if (!sessionID) {
        return;
      }
      agentSelect.title = 'Переключаю на ' + agentSelect.value + '…';
      vscode.postMessage({ type: 'setAgent', sessionID: sessionID, agent: agentSelect.value });
      vscode.postMessage({ type: 'setDefaultAgent', agent: agentSelect.value });
      updateDefaultButton();
    });

    let recRows = [];
    let telegramRow = null;

    function telegramActionButton(label, action, title) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'rec-action';
      button.textContent = label;
      button.title = title || label;
      button.addEventListener('click', function () {
        if (button.disabled) {
          return;
        }
        setTelegramBusy(true);
        telegramRow.desc.textContent = action === 'status' ? 'Обновляю…' : 'Выполняю…';
        vscode.postMessage({ type: 'telegramAction', action: action });
      });
      return button;
    }

    function setTelegramBusy(busy) {
      if (!telegramRow) {
        return;
      }
      for (const name of Object.keys(telegramRow.buttons)) {
        telegramRow.buttons[name].disabled = busy;
      }
      telegramRow.refresh.disabled = busy;
      telegramRow.token.disabled = busy;
      telegramRow.userId.disabled = busy;
      telegramRow.prereqInstall.disabled = busy;
      telegramRow.prereqRefresh.disabled = busy;
    }

    function applyTelegramState(state, note) {
      if (!telegramRow) {
        return;
      }
      const ready = Boolean(state.installed && state.configured);
      const blocked = !ready && Boolean(state.prereq && state.prereq.ready === false);
      telegramRow.installFoot.hidden = ready || blocked;
      telegramRow.hint.hidden = ready || blocked;
      telegramRow.prereqFoot.hidden = !blocked;
      telegramRow.controlFoot.hidden = !ready;
      if (!ready) {
        telegramRow.install.disabled = false;
        telegramRow.install.textContent = 'Установить';
        telegramRow.token.disabled = false;
        telegramRow.userId.disabled = false;
        telegramRow.prereqInstall.disabled = false;
        telegramRow.prereqRefresh.disabled = false;
        if (blocked) {
          const names = (state.prereq.missing || []).map((item) => item.text).join(', ');
          telegramRow.prereqText.textContent = 'Не хватает: ' + (names || 'зависимостей') + '. Установщик в терминале поставит Node.js/OpenCode и спросит модель, токен и ID.';
          telegramRow.desc.textContent = 'Сначала подготовьте OpenCode.';
        } else {
          telegramRow.desc.textContent = state.text || 'Установите бота, чтобы управлять им отсюда.';
        }
        telegramRow.statusLine.textContent = note || '';
        telegramRow.statusLine.hidden = !note;
        return;
      }
      telegramRow.token.value = '';
      telegramRow.buttons.start.disabled = Boolean(state.running);
      telegramRow.buttons.stop.disabled = !state.running;
      telegramRow.buttons.autostart.textContent = state.autostart ? '🚀 Автозапуск: вкл' : '🚀 Автозапуск: выкл';
      const summary = (state.running ? 'Бот работает.' : 'Бот остановлен.') + ' ' + (state.autostart ? 'Автозапуск включён.' : 'Автозапуск выключен.');
      telegramRow.desc.textContent = summary;
      telegramRow.statusLine.textContent = note || '';
      telegramRow.statusLine.hidden = !note;
      for (const name of Object.keys(telegramRow.buttons)) {
        telegramRow.buttons[name].disabled = false;
      }
      telegramRow.buttons.start.disabled = Boolean(state.running);
      telegramRow.buttons.stop.disabled = !state.running;
    }

    function buildTelegramRow(item, index, state) {
      const row = document.createElement('div');
      row.className = 'rec-item';

      const num = document.createElement('span');
      num.className = 'rec-num';
      num.textContent = String(index + 1);

      const body = document.createElement('div');
      body.className = 'rec-body';

      const name = document.createElement('div');
      name.className = 'rec-name';
      name.textContent = item.title || item.id;

      const desc = document.createElement('div');
      desc.className = 'rec-desc';
      desc.textContent = item.description || '';

      const hint = document.createElement('div');
      hint.className = 'rec-hint';
      hint.textContent = 'Токен и ID сохранятся локально в ~/.config/opencode-telegram-bot/.env.';

      const installFoot = document.createElement('div');
      installFoot.className = 'rec-foot rec-wrap';

      const token = document.createElement('input');
      token.type = 'password';
      token.className = 'rec-input';
      token.placeholder = 'Токен от @BotFather';
      token.autocomplete = 'off';
      token.spellcheck = false;

      const userId = document.createElement('input');
      userId.type = 'text';
      userId.className = 'rec-input';
      userId.placeholder = 'Telegram ID (цифры)';
      userId.inputMode = 'numeric';
      userId.autocomplete = 'off';
      userId.spellcheck = false;

      const install = document.createElement('button');
      install.type = 'button';
      install.className = 'rec-action';
      install.textContent = 'Установить';
      install.title = 'Установить пакет бота, настроить и запустить';
      install.addEventListener('click', function () {
        if (install.disabled) {
          return;
        }
        const tokenValue = token.value.trim();
        const userValue = userId.value.trim();
        if (!tokenValue || !userValue) {
          desc.textContent = 'Введите токен @BotFather и числовой Telegram ID.';
          return;
        }
        install.disabled = true;
        token.disabled = true;
        userId.disabled = true;
        install.textContent = 'Установка…';
        desc.textContent = 'Ставлю пакет бота и запускаю. Это может занять пару минут.';
        vscode.postMessage({ type: 'telegramInstall', token: tokenValue, userId: userValue });
      });

      installFoot.appendChild(token);
      installFoot.appendChild(userId);
      installFoot.appendChild(install);

      const prereqFoot = document.createElement('div');
      prereqFoot.className = 'rec-foot rec-wrap';
      prereqFoot.hidden = true;
      const prereqText = document.createElement('div');
      prereqText.className = 'rec-prereq';
      const prereqInstall = document.createElement('button');
      prereqInstall.type = 'button';
      prereqInstall.className = 'rec-action';
      prereqInstall.textContent = 'Установить в терминале';
      prereqInstall.title = 'Установщик поставит Node.js/OpenCode и спросит модель, токен и ID';
      prereqInstall.addEventListener('click', function () {
        if (prereqInstall.disabled) {
          return;
        }
        setTelegramBusy(true);
        desc.textContent = 'Установка идёт в терминале. Установщик поставит недостающее и спросит модель.';
        vscode.postMessage({ type: 'telegramAction', action: 'install' });
      });
      const prereqRefresh = document.createElement('button');
      prereqRefresh.type = 'button';
      prereqRefresh.className = 'rec-action rec-secondary';
      prereqRefresh.textContent = 'Проверить';
      prereqRefresh.title = 'Проверить ещё раз';
      prereqRefresh.addEventListener('click', function () {
        vscode.postMessage({ type: 'telegramState' });
      });
      prereqFoot.appendChild(prereqText);
      prereqFoot.appendChild(prereqInstall);
      prereqFoot.appendChild(prereqRefresh);

      const controlFoot = document.createElement('div');
      controlFoot.className = 'rec-foot rec-wrap';
      controlFoot.hidden = true;
      const buttons = {
        start: telegramActionButton('▶ Запустить', 'start', 'Запустить бота'),
        stop: telegramActionButton('⏹ Остановить', 'stop', 'Остановить бота'),
        restart: telegramActionButton('🔄 Перезапустить', 'restart', 'Перезапустить бота'),
        autostart: telegramActionButton('🚀 Автозапуск', 'autostart', 'Включить или выключить автозапуск'),
        status: telegramActionButton('📊 Статус', 'status', 'Показать состояние бота')
      };
      const refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.className = 'rec-action';
      refresh.textContent = '↻';
      refresh.title = 'Обновить состояние';
      refresh.addEventListener('click', function () {
        vscode.postMessage({ type: 'telegramState' });
      });
      for (const key of Object.keys(buttons)) {
        controlFoot.appendChild(buttons[key]);
      }
      controlFoot.appendChild(refresh);

      const statusLine = document.createElement('div');
      statusLine.className = 'rec-telegram-status';
      statusLine.hidden = true;

      body.appendChild(name);
      body.appendChild(desc);
      body.appendChild(hint);
      body.appendChild(installFoot);
      body.appendChild(prereqFoot);
      body.appendChild(controlFoot);
      body.appendChild(statusLine);
      row.appendChild(num);
      row.appendChild(body);

      telegramRow = { desc: desc, buttons: buttons, install: install, token: token, userId: userId, hint: hint, installFoot: installFoot, prereqFoot: prereqFoot, prereqText: prereqText, prereqInstall: prereqInstall, prereqRefresh: prereqRefresh, controlFoot: controlFoot, statusLine: statusLine, refresh: refresh };
      applyTelegramState(state || {}, '');
      return row;
    }

    function renderRecommended(items, telegram) {
      recRows = [];
      recList.textContent = '';
      telegramRow = null;
      if (!items || !items.length) {
        const empty = document.createElement('div');
        empty.className = 'rec-empty';
        empty.textContent = 'Список пуст.';
        recList.appendChild(empty);
        return;
      }
      items.forEach(function (item, index) {
        if (item.id === 'telegram') {
          recList.appendChild(buildTelegramRow(item, index, telegram));
          return;
        }
        const row = document.createElement('div');
        row.className = 'rec-item';

        const num = document.createElement('span');
        num.className = 'rec-num';
        num.textContent = String(index + 1);

        const body = document.createElement('div');
        body.className = 'rec-body';

        const name = document.createElement('div');
        name.className = 'rec-name';
        name.textContent = item.title || item.id;

        const desc = document.createElement('div');
        desc.className = 'rec-desc';
        desc.textContent = item.description || '';

        const foot = document.createElement('div');
        foot.className = 'rec-foot';

        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'rec-action';
        action.textContent = item.installed ? 'Обновить' : 'Установить';

        let fix = null;
        if (item.installed && item.fixable) {
          fix = document.createElement('button');
          fix.type = 'button';
          fix.className = 'rec-action';
          fix.textContent = 'Устранить';
          action.className = 'rec-action rec-secondary';
          fix.addEventListener('click', function () {
            fix.disabled = true;
            action.disabled = true;
            status.className = 'rec-status warn';
            status.textContent = 'устраняю…';
            vscode.postMessage({ type: 'fixRecommended', id: item.id });
          });
        }

        const status = document.createElement('span');
        status.className = 'rec-status' + (item.ready ? ' ok' : (item.installed ? ' warn' : ''));
        status.textContent = item.ready
          ? 'установлен'
          : (item.installed && item.missing && item.missing.length ? 'не готово · ' + item.missing.join(' · ') : '');

        action.addEventListener('click', function () {
          action.disabled = true;
          if (fix) {
            fix.disabled = true;
          }
          action.textContent = 'Установка…';
          status.className = 'rec-status';
          status.textContent = '';
          vscode.postMessage({ type: item.type === 'agent' ? 'installAgent' : 'installSkill', id: item.id });
        });

        if (fix) {
          foot.appendChild(fix);
        }
        foot.appendChild(action);
        foot.appendChild(status);
        body.appendChild(name);
        body.appendChild(desc);
        body.appendChild(foot);
        row.appendChild(num);
        row.appendChild(body);
        recList.appendChild(row);
        recRows.push({ id: item.id, action: action, fix: fix, status: status });
      });
    }

    function openRecommended() {
      recPanel.hidden = false;
      recList.textContent = 'Загрузка…';
      vscode.postMessage({ type: 'recommended' });
    }

    function closeRecommended() {
      recPanel.hidden = true;
    }

    recOpen.addEventListener('click', function () {
      if (recPanel.hidden) {
        openRecommended();
      } else {
        closeRecommended();
      }
    });
    recClose.addEventListener('click', closeRecommended);

    fullOpen.addEventListener('click', function () {
      const tab = activeTab();
      vscode.postMessage({ type: 'openFull', url: tab && tab.iframe ? tab.iframe.src : '' });
    });

    document.addEventListener('mousedown', function (event) {
      if (recPanel.hidden) {
        return;
      }
      const target = event.target;
      if (recOpen.contains(target)) {
        return;
      }
      if (!recPanel.contains(target)) {
        closeRecommended();
      }
    }, true);

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !recPanel.hidden) {
        closeRecommended();
      }
    });

    function cleanTitle(title) {
      const value = String(title || '').trim();
      const index = value.indexOf(' · ');
      const short = index >= 0 ? value.slice(0, index).trim() : value;
      return short && short.toLowerCase() !== 'opencode' ? short : '';
    }

    function setTabTitle(tab, title) {
      const value = cleanTitle(title);
      if (value && !/^new session\b/i.test(value)) {
        tab.label = value;
        tab.titleEl.textContent = value;
        tab.tabEl.title = value;
      }
    }

    function activateTab(id) {
      activeId = id;
      for (const tab of tabs) {
        const active = tab.id === id;
        tab.tabEl.classList.toggle('active', active);
        tab.paneEl.classList.toggle('active', active);
        if (active && tab.unread) {
          tab.unread = false;
        }
        updateTabState(tab);
      }
      updateSessionBack();
      renderCost(activeTab());
      updateAgentUi(activeTab());
      requestCost(activeTab());
    }

    function syncTabOrder() {
      const order = Array.prototype.map.call(tabsEl.querySelectorAll('.tab'), function (element) {
        return Number(element.dataset.tabId);
      });
      tabs.sort(function (left, right) {
        return order.indexOf(left.id) - order.indexOf(right.id);
      });
    }

    function closeTab(id) {      const index = tabs.findIndex(function (tab) { return tab.id === id; });
      if (index < 0) {
        return;
      }
      const tab = tabs[index];
      tab.tabEl.remove();
      tab.paneEl.remove();
      tabs.splice(index, 1);

      if (tabs.length === 0) {
        activeId = null;
        sessionBack.hidden = true;
        if (baseUrl) {
          createTab(baseUrl, 'Главная');
        }
        return;
      }

      if (activeId === id) {
        const next = tabs[Math.min(index, tabs.length - 1)];
        activateTab(next.id);
      } else {
        updateSessionBack();
      }
    }

    function createTab(url, label) {
      const id = nextId;
      nextId += 1;

      const tabEl = document.createElement('button');
      tabEl.type = 'button';
      tabEl.className = 'tab';
      tabEl.title = label;
      tabEl.dataset.tabId = String(id);

      const titleEl = document.createElement('span');
      titleEl.className = 'tab-title';
      titleEl.textContent = label;

      const dotEl = document.createElement('span');
      dotEl.className = 'tab-dot';
      dotEl.hidden = true;

      const closeEl = document.createElement('span');
      closeEl.className = 'tab-close';
      closeEl.textContent = '×';
      closeEl.title = 'Закрыть вкладку';

      tabEl.appendChild(dotEl);
      tabEl.appendChild(titleEl);
      tabEl.appendChild(closeEl);
      tabsEl.insertBefore(tabEl, addBtn);

      const paneEl = document.createElement('div');
      paneEl.className = 'pane';
      paneEl.dataset.tabId = String(id);

      const iframe = document.createElement('iframe');
      iframe.title = label;
      iframe.setAttribute('allow', 'clipboard-read; clipboard-write');
      paneEl.appendChild(iframe);
      panesEl.appendChild(paneEl);

      const tab = {
        id: id,
        label: label,
        route: '',
        busy: false,
        unread: false,
        cost: 0,
        tokens: null,
        agent: '',
        agentSynced: false,
        model: null,
        tabEl: tabEl,
        titleEl: titleEl,
        dotEl: dotEl,
        paneEl: paneEl,
        iframe: iframe
      };
      tabs.push(tab);

      tabEl.addEventListener('click', function (event) {
        if (event.target === closeEl) {
          closeTab(id);
          return;
        }
        activateTab(id);
      });
      closeEl.addEventListener('click', function (event) {
        event.stopPropagation();
        closeTab(id);
      });

      tabEl.draggable = true;
      tabEl.addEventListener('dragstart', function (event) {
        draggedId = id;
        tabEl.classList.add('dragging');
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', String(id));
        }
      });
      tabEl.addEventListener('dragend', function () {
        draggedId = null;
        tabEl.classList.remove('dragging');
        syncTabOrder();
      });

      iframe.addEventListener('load', function () {
        if (tabs.length === 1 && !loading.hidden) {
          stopLoading();
        }
      });

      activateTab(id);
      iframe.src = withTimestamp(url);
      tabsEl.scrollLeft = tabsEl.scrollWidth;
      return tab;
    }

    function reloadTabs(base, fallbackUrl) {
      const root = base.replace(/\/+$/, '');
      for (const tab of tabs) {
        const target = tab.route ? root + tab.route : fallbackUrl;
        tab.iframe.src = withTimestamp(target);
      }
    }

    let lastNewTabAt = 0;

    function newTab() {
      const now = Date.now();
      if (now - lastNewTabAt < 400) {
        return;
      }
      lastNewTabAt = now;
      if (!baseUrl) {
        return;
      }
      createTab(baseUrl, 'Новая сессия');
    }

    function tabFromSource(source) {
      for (const tab of tabs) {
        if (tab.iframe.contentWindow === source) {
          return tab;
        }
      }
      return null;
    }

    addBtn.addEventListener('click', newTab);

    tabsEl.addEventListener('dragover', function (event) {
      if (!draggedId) {
        return;
      }
      const target = event.target && event.target.closest ? event.target.closest('.tab') : null;
      const dragged = tabsEl.querySelector('.tab.dragging');
      if (!target || !dragged || target === dragged) {
        return;
      }
      event.preventDefault();
      const rect = target.getBoundingClientRect();
      const after = event.clientX > rect.left + rect.width / 2;
      tabsEl.insertBefore(dragged, after ? target.nextSibling : target);
    });

    tabsEl.addEventListener('drop', function (event) {
      if (draggedId) {
        event.preventDefault();
      }
    });

    retry.addEventListener('click', function () {
      startLoading('Запускаю opencode…');
      vscode.postMessage({ type: 'reloadEmbedded' });
    });

    installOpencode.addEventListener('click', function () {
      vscode.postMessage({ type: 'installOpencode' });
    });

    function goHome() {
      const tab = activeTab();
      if (!tab || !baseUrl) {
        return;
      }
      tab.route = '';
      tab.label = 'Главная';
      tab.titleEl.textContent = 'Главная';
      tab.tabEl.title = 'Главная';
      tab.iframe.src = withTimestamp(baseUrl);
      updateSessionBack();
      renderCost(tab);
      updateAgentUi(tab);
    }

    sessionBack.addEventListener('click', goHome);

    window.addEventListener('message', function (event) {
      const message = event.data;
      if (!message || !message.type) {
        return;
      }

      if (message.type === 'opencode-sidebar-route') {
        const tab = tabFromSource(event.source);
        if (!tab) {
          return;
        }
        tab.route = String(message.path || '');
        if (tab.id === activeId) {
          updateSessionBack();
          renderCost(tab);
          updateAgentUi(tab);
          requestCost(tab);
        }
        return;
      }

      if (message.type === 'sessionActivity') {
        for (const tab of tabs) {
          if (sessionIdOf(tab) !== message.sessionID) {
            continue;
          }
          const busy = Boolean(message.busy);
          if (!busy && tab.busy && tab.id !== activeId && message.outcome === 'succeeded') {
            tab.unread = true;
          }
          tab.busy = busy;
          updateTabState(tab);
          if (!busy) {
            requestCost(tab);
          }
        }
        return;
      }

      if (message.type === 'sessionCost') {
        for (const tab of tabs) {
          if (sessionIdOf(tab) !== message.sessionID) {
            continue;
          }
          tab.cost = Number(message.cost) || 0;
          tab.tokens = message.tokens || null;
          if (message.model) {
            tab.model = message.model;
          }
          if (message.title) {
            setTabTitle(tab, message.title);
          }
          if (message.agent) {
            tab.agent = message.agent;
            if (!tab.agentSynced && defaultAgent && message.agent !== defaultAgent) {
              tab.agent = defaultAgent;
              vscode.postMessage({ type: 'setAgent', sessionID: message.sessionID, agent: defaultAgent });
            }
            tab.agentSynced = true;
          }
          if (tab.id === activeId) {
            renderCost(tab);
            updateAgentUi(tab);
          }
        }
        return;
      }

		if (message.type === 'compactRequested') {
			for (const tab of tabs) {
				if (sessionIdOf(tab) !== message.sessionID) {
					continue;
				}
				tab.compactPending = false;
				updateTabState(tab);
				if (tab.id === activeId) {
					compactBtn.title = message.ok
						? 'Запрос принят. Ход и результат сжатия отображаются в чате.'
						: 'Не удалось запросить сжатие: ' + (message.message || 'ошибка');
				}
			}
			return;
		}

      if (message.type === 'newTab') {
        newTab();
        return;
      }

      if (message.type === 'opencode-sidebar-title') {
        const tab = tabFromSource(event.source);
        if (tab) {
          setTabTitle(tab, message.title);
        }
        return;
      }

      if (message.type === 'opencode-sidebar-new-tab') {
        if (tabFromSource(event.source)) {
          newTab();
        }
        return;
      }

      if (message.type === 'capabilities') {
        graphifyBtn.hidden = !message.graphify;
        return;
      }

      if (message.type === 'graphifyStarted') {
        graphifyBtn.disabled = false;
        graphifyBtn.title = message.ok
          ? 'Graphify запущен в этой сессии'
          : 'Не удалось запустить: ' + (message.message || 'ошибка');
        return;
      }

      if (message.type === 'agents') {
        renderAgents(message.items);
        if (message.defaultAgent) {
          defaultAgent = message.defaultAgent;
        }
        updateDefaultButton();
        return;
      }

      if (message.type === 'models') {
        renderModels(message.items, message.defaultModel);
        return;
      }

      if (message.type === 'defaultModelSet') {
        if (message.ok) {
          modelSelect.title = 'Модель по умолчанию: ' + message.model + (message.deferred ? ' (применится после ответа)' : '');
        } else {
          modelSelect.title = 'Не удалось: ' + (message.message || 'ошибка');
        }
        return;
      }

      if (message.type === 'defaultAgentSet') {
        if (message.ok) {
          defaultAgent = message.agent;
          updateDefaultButton();
        } else {
          agentSelect.title = 'Не удалось сделать умолчанием: ' + (message.message || 'ошибка');
        }
        return;
      }

      if (message.type === 'agentChanged') {
        for (const tab of tabs) {
          if (sessionIdOf(tab) !== message.sessionID) {
            continue;
          }
          if (message.ok) {
            tab.agent = message.agent;
          }
          if (tab.id === activeId) {
            updateAgentUi(tab);
            if (!message.ok) {
              agentSelect.title = 'Не удалось переключить: ' + (message.message || 'ошибка');
              requestCost(tab);
            }
          }
        }
        return;
      }

      if (message.type === 'recommended') {
        renderRecommended(message.items, message.telegram);
        return;
      }

      if (message.type === 'telegramState') {
        applyTelegramState(message);
        return;
      }

      if (message.type === 'telegramResult') {
        applyTelegramState(message.state || {}, message.text);
        return;
      }
      if (message.type === 'skillInstalled' || message.type === 'agentInstalled') {
        const row = recRows.find(function (entry) { return entry.id === message.id; });
        if (!row) {
          return;
        }
        row.action.disabled = false;
        if (row.fix) {
          row.fix.disabled = false;
        }
        if (message.ok) {
          row.action.textContent = 'Обновить';
          row.status.className = 'rec-status ok';
          row.status.textContent = message.type === 'agentInstalled' ? 'установлен, нужен reload' : 'обновлено';
          if (message.type === 'skillInstalled') {
            vscode.postMessage({ type: 'recommended' });
          }
        } else {
          row.action.textContent = 'Повторить';
          row.status.className = 'rec-status fail';
          row.status.textContent = message.message || 'ошибка';
        }
        return;
      }

      if (message.type === 'recommendedFixed') {
        const row = recRows.find(function (entry) { return entry.id === message.id; });
        if (!row) {
          return;
        }
        row.action.disabled = false;
        if (row.fix) {
          row.fix.disabled = false;
        }
        row.action.textContent = 'Обновить';
        if (message.ok) {
          if (row.fix) {
            row.fix.remove();
            row.fix = null;
          }
          row.status.className = 'rec-status ok';
          row.status.textContent = (message.text || 'готово') + ' Нажмите «Обновить», чтобы проверить.';
        } else {
          row.status.className = 'rec-status fail';
          row.status.textContent = message.message || 'не удалось устранить';
        }
        return;
      }

      if (message.type === 'embedded-starting') {
        startLoading('Запускаю opencode…');
        return;
      }

      if (message.type === 'embedded') {
        const nextBase = normalizeBase(message.url);
        if (!nextBase) {
          showError('Некорректный адрес opencode.');
          return;
        }
        if (!baseUrl || nextBase !== baseUrl || tabs.length === 0) {
          for (const tab of tabs.slice()) {
            tab.tabEl.remove();
            tab.paneEl.remove();
          }
          tabs = [];
          activeId = null;
          baseUrl = nextBase;
          addBtn.disabled = false;
          startLoading('Загружаю opencode…');
          createTab(message.url, 'Главная');
        } else {
          if (message.reloaded) {
            reloadTabs(nextBase, message.url);
          }
          stopLoading();
        }
        addBtn.disabled = false;
        return;
      }

      if (message.type === 'embedded-error') {
        showError(message.message, Boolean(message.installable));
      }
    });

    vscode.postMessage({ type: 'ready' });
    vscode.postMessage({ type: 'capabilities' });
    startLoading('Запускаю opencode…');
  })();
