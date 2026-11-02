'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const zlib = require('zlib');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { URL } = require('url');

const START_RETRIES = 20;
const START_DELAY_MS = 300;
const COMMAND_TIMEOUT_MS = 20000;
const PORT_RETRIES = 6;
const PORT_RETRY_DELAY_MS = 120;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);
const CSP = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' http: https:; style-src 'self' 'unsafe-inline' http: https:; img-src * data: blob:; font-src * data:; media-src * data: blob:; connect-src * data: blob: ws: wss: http: https:; worker-src 'self' blob:; frame-src 'self' http: https:;";

function stripAnsi(value) {
  return String(value || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function windowsQuote(value) {
  const text = String(value);
  if (text && /^[A-Za-z0-9_./:@%+=,\\-]+$/.test(text)) {
    return text;
  }
  return '"' + text.replace(/"/g, '\\"') + '"';
}

function run(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const execOptions = {
      cwd: options.cwd,
      timeout: options.timeout || COMMAND_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024
    };
    const callback = (error, stdout, stderr) => {
      const output = stripAnsi(stdout).trim();
      if (error && !output) {
        const errorText = stripAnsi(stderr).trim();
        reject(new Error(errorText || error.message));
        return;
      }
      resolve(output);
    };

    if (binary) {
      execFile(binary, args, execOptions, callback);
      return;
    }

    const isWindows = process.platform === 'win32';
    const shell = isWindows ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/sh');
    if (isWindows) {
      const line = ['opencode', ...args].map(windowsQuote).join(' ');
      execFile(shell, ['/d', '/s', '/c', line], { ...execOptions, windowsVerbatimArguments: true }, callback);
      return;
    }
    const command = ['opencode', ...args].map(shellQuote).join(' ');
    execFile(shell, ['-lc', command], execOptions, callback);
  });
}

function parseServiceUrl(text) {
  const line = String(text || '').split(/\r?\n/).map((value) => value.trim())
    .find((value) => /^https?:\/\//i.test(value));
  if (!line) {
    return null;
  }
  try {
    const url = new URL(line);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function readServicePassword() {
  const files = [];
  if (process.env.XDG_CONFIG_HOME) {
    files.push(path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'service.json'));
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    files.push(path.join(process.env.APPDATA, 'opencode', 'service.json'));
  }
  files.push(path.join(os.homedir(), '.config', 'opencode', 'service.json'));
  files.push(path.join(os.homedir(), 'Library', 'Application Support', 'opencode', 'service.json'));

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && typeof data.password === 'string' && data.password) {
        return data.password;
      }
    } catch {
      // Ignore missing or unreadable config files.
    }
  }
  return '';
}

async function resolveService(binary, cwd) {
  let status = '';
  try {
    status = await run(binary, ['service', 'status'], { cwd });
  } catch {
    status = '';
  }

  let upstream = parseServiceUrl(status);
  if (!upstream) {
    try {
      await run(binary, ['service', 'start'], { cwd, timeout: 30000 });
    } catch {
      // The status check below will report the real error.
    }
    for (let attempt = 0; attempt < START_RETRIES; attempt += 1) {
      await delay(START_DELAY_MS);
      try {
        status = await run(binary, ['service', 'status'], { cwd });
      } catch {
        status = '';
      }
      upstream = parseServiceUrl(status);
      if (upstream) {
        break;
      }
    }
  }

  if (!upstream) {
    throw new Error('Не удалось запустить сервис opencode. Проверьте команду «opencode service start».');
  }

  let password = '';
  try {
    password = await run(binary, ['service', 'get', 'password'], { cwd });
  } catch {
    password = '';
  }
  if (!password) {
    password = readServicePassword();
  }
  if (!password) {
    throw new Error('Не удалось получить пароль сервиса opencode.');
  }

  return { upstream, password };
}

function upstreamPort(upstream) {
  if (upstream.port) {
    return Number(upstream.port);
  }
  return upstream.protocol === 'https:' ? 443 : 80;
}

function decodeBody(buffer, encoding) {
  const value = String(encoding || '').toLowerCase();
  if (!value) {
    return buffer;
  }
  try {
    if (value.includes('gzip')) {
      return zlib.gunzipSync(buffer);
    }
    if (value.includes('deflate')) {
      return zlib.inflateSync(buffer);
    }
    if (value.includes('br')) {
      return zlib.brotliDecompressSync(buffer);
    }
  } catch {
    return buffer;
  }
  return buffer;
}

function injectConfig(html, password, hostname) {
  const script = [
    '<script>(function(){try{',
    'try{if(!localStorage.getItem("opencode-sidebar-reset")){localStorage.clear();localStorage.setItem("opencode-sidebar-reset","1")}}catch(e){}',
    'var o=location.origin;',
    'var p=' + JSON.stringify(password) + ';',
    'var h=' + JSON.stringify(hostname) + ';',
    'var key="opencode.global.dat:server";',
    'var s={};try{var raw=localStorage.getItem(key);if(raw)s=JSON.parse(raw)||{}}catch(e){}',
    'if(!s||typeof s!=="object")s={};',
    'if(!Array.isArray(s.list))s.list=[];',
    's.list=s.list.filter(function(x){return !(x&&x.http&&x.http.url===o)});',
    's.list.unshift({type:"http",http:{url:o,password:p}});',
    'if(!s.hidden)s.hidden={};if(!s.lastProjectID)s.lastProjectID={};',
    'if(!s.usedProjectIDs)s.usedProjectIDs={};if(!s.projects)s.projects={};',
    'if(!s.hostnames)s.hostnames={};s.hostnames[o]=h;',
    'localStorage.setItem(key,JSON.stringify(s));',
    '}catch(e){console.error("opencode-sidebar:",e)}',
    'function r(){try{parent.postMessage({type:"opencode-sidebar-route",path:location.pathname},"*")}catch(e){}}',
    'var last="";r();setInterval(function(){if(location.pathname!==last){last=location.pathname;r()}},300);',
    'function ti(){try{parent.postMessage({type:"opencode-sidebar-title",title:document.title},"*")}catch(e){}}',
    'var lt="";ti();setInterval(function(){if(document.title!==lt){lt=document.title;ti()}},500);',
    'window.addEventListener("keydown",function(e){try{if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&!e.altKey&&String(e.key).toLowerCase()==="t"){e.preventDefault();e.stopPropagation();parent.postMessage({type:"opencode-sidebar-new-tab"},"*")}}catch(x){}},true);',
    '})();</script><style id="opencode-sidebar-style">[data-slot="titlebar-v2"]{display:none !important}</style>'
  ].join('');

  return /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (match) => match + script)
    : script + html;
}

function buildUpstreamHeaders(req, upstream) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && value !== undefined) {
      headers[key] = value;
    }
  }
  headers.host = upstream.host;
  headers['accept-encoding'] = 'identity';
  if (headers.origin) {
    headers.origin = upstream.origin;
  }
  if (headers.referer) {
    headers.referer = upstream.origin + '/';
  }
  return headers;
}

function sanitizeResponseHeaders(source) {
  const headers = {};
  for (const [key, value] of Object.entries(source)) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && value !== undefined) {
      headers[key] = value;
    }
  }
  return headers;
}

function proxyBase(server) {
  const address = server.address();
  return 'http://127.0.0.1:' + (address && address.port ? address.port : 0);
}

function handleProxyResponse(res, proxyRes, server, service, onEvent) {
  const headers = sanitizeResponseHeaders(proxyRes.headers);
  if (headers.location && headers.location.startsWith(service.upstream.origin)) {
    headers.location = headers.location.replace(service.upstream.origin, proxyBase(server));
  }

  const contentType = String(headers['content-type'] || '');
  if (contentType.includes('text/event-stream')) {
    res.writeHead(proxyRes.statusCode || 502, headers);
    if (onEvent) {
      let buffer = '';
      proxyRes.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (buffer.length > 256 * 1024) {
          buffer = buffer.slice(-4096);
        }
        let index = buffer.indexOf('\n\n');
        while (index >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const lines = block.split('\n');
          const eventLine = lines.find((line) => line.startsWith('event:'));
          const dataLine = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
          let data = null;
          try {
            data = dataLine ? JSON.parse(dataLine) : null;
          } catch {
            data = null;
          }
          onEvent({ event: eventLine ? eventLine.slice(6).trim() : '', data });
          index = buffer.indexOf('\n\n');
        }
      });
    }
    proxyRes.pipe(res);
    return;
  }

  if (!contentType.includes('text/html')) {
    res.writeHead(proxyRes.statusCode || 502, headers);
    proxyRes.pipe(res);
    return;
  }

  const chunks = [];
  proxyRes.on('data', (chunk) => chunks.push(chunk));
  proxyRes.on('end', () => {
    const decoded = decodeBody(Buffer.concat(chunks), headers['content-encoding']);
    let body = decoded.toString('utf8');
    body = body.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, '');
    body = body.split(service.upstream.origin).join(proxyBase(server));
    body = injectConfig(body, service.password, os.hostname());

    delete headers['content-security-policy'];
    delete headers['content-security-policy-report-only'];
    delete headers['x-frame-options'];
    delete headers['content-length'];
    delete headers['content-encoding'];
    delete headers['transfer-encoding'];
    headers['content-security-policy'] = CSP;
    headers['content-length'] = Buffer.byteLength(body);

    res.writeHead(proxyRes.statusCode || 200, headers);
    res.end(body);
  });
}

function listenOn(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function bindServer(server, preferredPort) {
  if (preferredPort) {
    for (let attempt = 0; attempt < PORT_RETRIES; attempt += 1) {
      try {
        return { port: await listenOn(server, preferredPort), reused: true };
      } catch (error) {
        if (error.code !== 'EADDRINUSE') {
          break;
        }
        await delay(PORT_RETRY_DELAY_MS);
      }
    }
  }
  return { port: await listenOn(server, 0), reused: false };
}

async function startProxy(service, options = {}) {
  const client = service.upstream.protocol === 'https:' ? https : http;
  const isSecure = service.upstream.protocol === 'https:';
  const sockets = new Set();
  const upstreamSockets = new Set();

  const server = http.createServer((req, res) => {
    if (req.url.split('?')[0] === '/sw.js') {
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-store'
      });
      res.end("self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',()=>self.clients.claim());");
      return;
    }

    const proxyReq = client.request({
      hostname: service.upstream.hostname,
      port: upstreamPort(service.upstream),
      path: req.url,
      method: req.method,
      headers: buildUpstreamHeaders(req, service.upstream),
      agent: false
    }, (proxyRes) => handleProxyResponse(res, proxyRes, server, service, options.onEvent));

    proxyReq.on('socket', (socket) => {
      upstreamSockets.add(socket);
      socket.on('close', () => upstreamSockets.delete(socket));
    });

    proxyReq.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      }
      res.end('opencode: upstream error');
    });
    req.pipe(proxyReq);
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.on('upgrade', (req, socket, head) => {
    const headers = buildUpstreamHeaders(req, service.upstream);
    const lines = [req.method + ' ' + req.url + ' HTTP/1.1'];
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          lines.push(key + ': ' + item);
        }
      } else if (value !== undefined) {
        lines.push(key + ': ' + value);
      }
    }

    let upstreamSocket;
    const onConnect = () => {
      upstreamSocket.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) {
        upstreamSocket.write(head);
      }
      socket.pipe(upstreamSocket).pipe(socket);
    };

    if (isSecure) {
      upstreamSocket = tls.connect({
        host: service.upstream.hostname,
        port: upstreamPort(service.upstream),
        servername: service.upstream.hostname
      }, onConnect);
    } else {
      upstreamSocket = net.connect({
        host: service.upstream.hostname,
        port: upstreamPort(service.upstream)
      }, onConnect);
    }

    upstreamSocket.on('error', () => socket.destroy());
    socket.on('error', () => upstreamSocket.destroy());
    upstreamSockets.add(upstreamSocket);
    upstreamSocket.on('close', () => upstreamSockets.delete(upstreamSocket));
  });

  const bound = await bindServer(server, options.port);
  const port = bound.port;
  return {
    url: 'http://127.0.0.1:' + port + '/',
    port,
    reused: bound.reused,
    close: () => new Promise((done) => {
      for (const socket of sockets) {
        socket.destroy();
      }
      for (const socket of upstreamSockets) {
        socket.destroy();
      }
      server.close(() => done());
    })
  };
}

async function startOpencodeWebUi(options = {}) {
  const service = await resolveService(options.binary || '', options.cwd);
  return startProxy(service, { port: options.port, onEvent: options.onEvent });
}

async function apiGet(binary, cwd, apiPath) {
  const text = await run(binary || '', ['api', 'GET', apiPath], { cwd, timeout: COMMAND_TIMEOUT_MS });
  return JSON.parse(text);
}

async function apiPost(binary, cwd, apiPath, body) {
  const text = await run(binary || '', ['api', 'POST', apiPath, '--data', JSON.stringify(body)], { cwd, timeout: COMMAND_TIMEOUT_MS });
  return text ? JSON.parse(text) : null;
}

async function reloadOpencode(binary, cwd) {
  await run(binary || '', ['reload'], { cwd, timeout: COMMAND_TIMEOUT_MS });
}

module.exports = { startOpencodeWebUi, apiGet, apiPost, reloadOpencode };
