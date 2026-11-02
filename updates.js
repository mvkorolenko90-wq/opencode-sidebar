'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { exec } = require('child_process');

const DEFAULT_REPO = 'mvkorolenko90-wq/opencode-sidebar';
const USER_AGENT = 'opencode-sidebar-updater';
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 20000;

function request(url, redirects) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
      timeout: TIMEOUT_MS
    }, (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location && redirects < MAX_REDIRECTS) {
        response.resume();
        request(new URL(location, url).toString(), redirects + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error('GitHub ответил ' + status + '. Проверьте сеть и адрес релиза.'));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('GitHub не ответил за ' + Math.round(TIMEOUT_MS / 1000) + ' секунд.')));
    req.on('error', reject);
  });
}

function parseVersion(value) {
  return String(value || '')
    .replace(/^[vV]/, '')
    .split(/[.\-+]/)
    .map((part) => Number.parseInt(part, 10) || 0);
}

function isNewer(candidate, current) {
  const left = parseVersion(candidate);
  const right = parseVersion(current);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] || 0;
    const b = right[index] || 0;
    if (a !== b) {
      return a > b;
    }
  }
  return false;
}

async function latestRelease(repo = DEFAULT_REPO) {
  const body = await request('https://api.github.com/repos/' + repo + '/releases/latest', 0);
  let data;
  try {
    data = JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('Не удалось разобрать ответ GitHub.');
  }
  const version = String(data.tag_name || '').replace(/^[vV]/, '');
  if (!version) {
    throw new Error('В ответе GitHub нет версии релиза.');
  }
  const asset = (data.assets || []).find((item) => item && typeof item.name === 'string' && /\.vsix$/i.test(item.name));
  if (!asset || !asset.browser_download_url) {
    throw new Error('В последнем релизе нет VSIX: ' + version + '.');
  }
  return {
    version,
    name: path.basename(asset.name),
    url: String(asset.browser_download_url),
    publishedAt: String(data.published_at || '')
  };
}

async function downloadVsix(release, dir) {
  const name = path.basename(String((release && release.name) || ''));
  if (!/\.vsix$/i.test(name)) {
    throw new Error('Неизвестное имя файла релиза.');
  }
  const target = path.join(dir || path.join(os.tmpdir(), 'opencode-sidebar-updates'), name);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const body = await request(release.url, 0);
  await fs.promises.writeFile(target, body);
  return target;
}

function installWithCli(file) {
  const windows = process.platform === 'win32';
  const commands = windows
    ? ['code.cmd', 'code', 'code-insiders.cmd', 'code-insiders']
    : ['code', 'code-insiders'];
  const quote = windows
    ? (value) => '"' + value + '"'
    : (value) => "'" + value.replace(/'/g, "'\\''") + "'";

  const attempt = (index) => new Promise((resolve, reject) => {
    if (index >= commands.length) {
      reject(new Error('Не найден CLI code. Установите VSIX вручную из GitHub Releases.'));
      return;
    }
    exec(quote(commands[index]) + ' --install-extension ' + quote(file) + ' --force', {
      timeout: 120000,
      windowsHide: true
    }, (error) => {
      if (error) {
        attempt(index + 1).then(resolve, reject);
        return;
      }
      resolve();
    });
  });

  return attempt(0);
}

module.exports = {
  DEFAULT_REPO,
  parseVersion,
  isNewer,
  latestRelease,
  downloadVsix,
  installWithCli
};
