#!/usr/bin/env node
// Foundry VTT v14 <-> Authelia (forward-auth) shim.
//
// Sits between Caddy and Foundry. Caddy has already authenticated the user with Authelia and
// forwards Remote-User / Remote-Groups. The shim:
//   * logs players into the Foundry user with the same name (empty password) on GET /join,
//   * refuses a POST /join for any user other than the authenticated one (admins may pick anyone),
//   * blocks the setup/admin views for non-admins,
//   * proxies everything else (including WebSocket) to Foundry untouched.
// No Foundry file is modified.

// http-proxy 1.x calls the deprecated util._extend (DEP0060); the warning is harmless noise in the journal.
process.noDeprecation = true;

import http from 'node:http';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import httpProxy from 'http-proxy';
import { io } from 'socket.io-client';

const env = (key, fallback) => process.env[key] ?? fallback;

const CFG = {
  port: Number(env('PORT', '30001')),
  host: env('HOST', '127.0.0.1'),
  upstream: env('UPSTREAM', 'http://127.0.0.1:30000').replace(/\/+$/, ''),
  headerUser: env('HEADER_USERNAME', 'remote-user').toLowerCase(),
  headerGroups: env('HEADER_GROUPS', 'remote-groups').toLowerCase(),
  groupsSeparator: env('GROUPS_SEPARATOR', ','),
  roleAdmin: env('ROLE_ADMIN', 'foundry-admin'),
  rolePlayer: env('ROLE_PLAYER', 'foundry-player'),
  secret: env('SHIM_SECRET', ''),
  publicOrigin: env('PUBLIC_ORIGIN', ''),
  forwardedProto: env('FORWARDED_PROTO', 'https'),
  autoLogin: env('AUTO_LOGIN', 'true') === 'true',
  // Also log administrators straight into the world (default: they get the normal join screen).
  autoLoginAdmin: env('AUTO_LOGIN_ADMIN', 'false') === 'true',
  // "lldapname=Foundry user name,other=Other user" (names compared case-insensitively).
  userMap: new Map(
    env('USER_MAP', '')
      .split(',')
      .map((pair) => pair.split('=').map((s) => s.trim()))
      .filter((pair) => pair.length === 2 && pair[0] && pair[1])
      .map(([from, to]) => [from.toLowerCase(), to]),
  ),
  debug: env('DEBUG', '') !== '',
};

const log = (...args) => console.log(new Date().toISOString(), ...args);
const dbg = (...args) => { if (CFG.debug) log('[debug]', ...args); };

// ---------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function identity(req) {
  const username = String(req.headers[CFG.headerUser] ?? '').trim();
  const groups = String(req.headers[CFG.headerGroups] ?? '')
    .split(CFG.groupsSeparator)
    .map((g) => g.trim())
    .filter(Boolean);
  return {
    username,
    isAdmin: groups.includes(CFG.roleAdmin),
    isPlayer: groups.includes(CFG.rolePlayer),
  };
}

/** Name of the Foundry user an authenticated username maps to. */
function foundryName(username) {
  return CFG.userMap.get(username.toLowerCase()) ?? username;
}

/** Returns the identity, or null if the request must be refused (the reason is logged). */
function authorize(req) {
  if (CFG.secret) {
    const got = String(req.headers['x-shim-secret'] ?? '');
    if (!safeEqual(got, CFG.secret)) {
      log(`refused ${req.method} ${req.url}: missing or wrong X-Shim-Secret`);
      return null;
    }
  }
  const ident = identity(req);
  if (!ident.username) {
    log(`refused ${req.method} ${req.url}: no ${CFG.headerUser} header from the proxy`);
    return null;
  }
  if (!(ident.isAdmin || ident.isPlayer)) {
    log(`refused ${req.method} ${req.url}: "${ident.username}" is not in ${CFG.rolePlayer} or ${CFG.roleAdmin}`
      + ` (groups: "${req.headers[CFG.headerGroups] ?? ''}")`);
    return null;
  }
  return ident;
}

function deny(res, status, message, json = false) {
  if (res.headersSent) return;
  if (json) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ status: 'error', message }));
  } else {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(message);
  }
}

// ---------------------------------------------------------------------------------------------
// Talking to Foundry (as a client)
// ---------------------------------------------------------------------------------------------

function upstreamHeaders(extra = {}) {
  const headers = {
    'user-agent': 'foundry-authelia-shim',
    'x-forwarded-proto': CFG.forwardedProto,
    ...extra,
  };
  if (CFG.publicOrigin) headers.origin = CFG.publicOrigin;
  return headers;
}

function parseCookieHeader(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

/** Merge lists of raw Set-Cookie strings, the last one for a given cookie name wins. */
function mergeSetCookies(...lists) {
  const byName = new Map();
  for (const list of lists) {
    for (const raw of list) {
      const name = raw.split(';')[0].split('=')[0].trim();
      byName.set(name, raw);
    }
  }
  return [...byName.values()];
}

function cookieHeaderFromSetCookies(rawList) {
  return rawList.map((raw) => raw.split(';')[0]).join('; ');
}

/** Ask Foundry for a brand new session. Returns the raw Set-Cookie strings. */
async function newUpstreamSession() {
  const response = await fetch(`${CFG.upstream}/join`, {
    redirect: 'manual',
    headers: upstreamHeaders(),
  });
  const setCookies = response.headers.getSetCookie();
  if (!setCookies.length) throw new Error(`Foundry did not set a session cookie (HTTP ${response.status})`);
  return setCookies;
}

/** Open a socket with the given Cookie header, return the `session` event and the getJoinData reply. */
function fetchJoinData(cookie) {
  return new Promise((resolve, reject) => {
    const socket = io(CFG.upstream, {
      path: '/socket.io',
      transports: ['websocket'],
      upgrade: false,
      reconnection: false,
      extraHeaders: upstreamHeaders({ cookie }),
    });
    const timer = setTimeout(() => finish(reject, new Error('timeout waiting for getJoinData')), 8000);
    const finish = (fn, value) => {
      clearTimeout(timer);
      socket.close();
      fn(value);
    };
    socket.on('connect_error', (err) => finish(reject, err));
    socket.on('session', (session) => {
      socket.emit('getJoinData', (data) => finish(resolve, { session, data }));
    });
  });
}

// username (lowercase) -> Foundry user id, cached briefly.
let usersCache = { at: 0, byName: new Map() };

async function refreshUsers() {
  const setCookies = await newUpstreamSession();
  const { data } = await fetchJoinData(cookieHeaderFromSetCookies(setCookies));
  const byName = new Map();
  for (const user of data?.users ?? []) {
    byName.set(String(user.name).toLowerCase(), user._id ?? user.id);
  }
  usersCache = { at: Date.now(), byName };
  dbg('users refreshed', [...byName.keys()]);
}

async function foundryUserId(username) {
  const key = username.toLowerCase();
  const age = Date.now() - usersCache.at;
  if (age > 30_000) await refreshUsers();
  let id = usersCache.byName.get(key);
  if (!id && age > 5_000) {
    await refreshUsers(); // maybe the user was created a moment ago
    id = usersCache.byName.get(key);
  }
  return id ?? null;
}

// ---------------------------------------------------------------------------------------------
// Auto-login on GET /join
// ---------------------------------------------------------------------------------------------

/** Returns true if the response was sent (redirect to the game), false to fall back to the normal page. */
async function autoLogin(req, res, ident) {
  const wanted = foundryName(ident.username);
  const userId = await foundryUserId(wanted);
  if (!userId) {
    log(`auto-login: no Foundry user named "${wanted}"`
      + (wanted !== ident.username ? ` (mapped from "${ident.username}")` : ''));
    return false;
  }

  // Reuse the browser's session if it is valid and not bound to somebody else.
  let cookieHeader = null;
  let newCookies = [];
  const browserSession = parseCookieHeader(req.headers.cookie).session;
  if (browserSession) {
    try {
      const { session } = await fetchJoinData(`session=${browserSession}`);
      if (session?.sessionId === browserSession) {
        if (session.userId === userId) {
          res.writeHead(302, { location: '/game', 'cache-control': 'no-store' });
          res.end();
          return true;
        }
        if (!session.userId) cookieHeader = `session=${browserSession}`;
      }
    } catch (err) {
      dbg('could not inspect browser session', err.message);
    }
  }
  if (!cookieHeader) {
    newCookies = await newUpstreamSession();
    cookieHeader = cookieHeaderFromSetCookies(newCookies);
  }

  const response = await fetch(`${CFG.upstream}/join`, {
    method: 'POST',
    redirect: 'manual',
    // Foundry v14 rejects a POST /join without "Sec-Fetch-Site: same-origin" (a browser adds it on its own,
    // a server-side fetch does not), answering HTTP 400 "The request could not be processed."
    headers: upstreamHeaders({
      'content-type': 'application/json',
      cookie: cookieHeader,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    }),
    body: JSON.stringify({ userId, password: '', action: 'join' }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.status !== 'success') {
    log(`auto-login failed for "${ident.username}": HTTP ${response.status}`, body);
    return false;
  }

  const setCookies = mergeSetCookies(newCookies, response.headers.getSetCookie());
  const headers = { location: body.redirect || '/game', 'cache-control': 'no-store' };
  if (setCookies.length) headers['set-cookie'] = setCookies;
  res.writeHead(302, headers);
  res.end();
  log(`auto-login ok: ${ident.username}${wanted !== ident.username ? ` as ${wanted}` : ''}`);
  return true;
}

// ---------------------------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------------------------

const proxy = httpProxy.createProxyServer({
  target: CFG.upstream,
  ws: true,
  xfwd: false, // Caddy already sets X-Forwarded-*
  changeOrigin: false, // keep the public Host header
});

proxy.on('error', (err, req, res) => {
  log('proxy error:', err.message);
  if (res && typeof res.writeHead === 'function') deny(res, 502, 'Bad gateway');
  else if (res && typeof res.destroy === 'function') res.destroy();
});

const ADMIN_ONLY_PATHS = /^\/(setup|auth|license|update|create|players)(\/|$)/;

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const ident = authorize(req);
  if (!ident) return deny(res, 403, 'Forbidden');
  delete req.headers['x-shim-secret'];
  dbg(`${req.method} ${req.url} user="${ident.username}" admin=${ident.isAdmin}`
    + ` cookie=${parseCookieHeader(req.headers.cookie).session ? 'yes' : 'no'}`
    + ` html=${String(req.headers.accept ?? '').includes('text/html')}`);

  const url = new URL(req.url, 'http://shim.local');
  const path = url.pathname;

  if (!ident.isAdmin && ADMIN_ONLY_PATHS.test(path)) {
    return deny(res, 403, 'Forbidden: administrators only');
  }

  // Login attempt: players may only log in as themselves.
  if (req.method === 'POST' && path === '/join') {
    const raw = await readBody(req);
    if (!ident.isAdmin) {
      let body;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return deny(res, 400, 'Bad request', true);
      }
      if (body?.action !== 'join') return deny(res, 403, 'Forbidden', true);
      const ownId = await foundryUserId(foundryName(ident.username));
      if (!ownId || body.userId !== ownId) {
        log(`blocked join as ${body?.userId} by "${ident.username}"`);
        return deny(res, 403, 'You can only join as your own user', true);
      }
    }
    return proxy.web(req, res, { buffer: Readable.from([raw]) });
  }

  // Page load of the join screen: log players in automatically.
  const wantsHtml = String(req.headers.accept ?? '').includes('text/html');
  if (req.method === 'GET' && path === '/join' && wantsHtml) {
    let skip = null;
    if (!CFG.autoLogin) skip = 'AUTO_LOGIN is off';
    else if (url.searchParams.has('noauto')) skip = '?noauto';
    else if (ident.isAdmin && !CFG.autoLoginAdmin) skip = 'administrator (AUTO_LOGIN_ADMIN is off)';
    if (skip) {
      log(`join page for "${ident.username}" served without auto-login: ${skip}`);
    } else {
      try {
        if (await autoLogin(req, res, ident)) return;
      } catch (err) {
        log('auto-login error:', err.message);
      }
    }
  }

  return proxy.web(req, res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    log('handler error:', err);
    deny(res, 500, 'Internal error');
  });
});

server.on('upgrade', (req, socket, head) => {
  const ident = authorize(req);
  if (!ident) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  delete req.headers['x-shim-secret'];
  dbg(`WS ${req.url} user="${ident.username}" cookie=${parseCookieHeader(req.headers.cookie).session ? 'yes' : 'no'}`);
  proxy.ws(req, socket, head);
});

server.listen(CFG.port, CFG.host, () => {
  log(`shim listening on ${CFG.host}:${CFG.port} -> ${CFG.upstream}`
    + ` (autoLogin=${CFG.autoLogin}, secret=${CFG.secret ? 'set' : 'NOT SET'})`);
});
