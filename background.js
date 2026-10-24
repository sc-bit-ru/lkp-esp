/* Исходящие запросы только на адрес приёма из настроек. Кабинет отсюда не открывается. */
importScripts('lib.js');

var ALARM = 'esp-lkp-flush';
var SPEC_TTL_MS = 6 * 60 * 60 * 1000;
var SENT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

var dbPromise = null;
var flushing = false;
var flushAgain = false;
var pauseAlarm = false;

function reqp(req) {
  return new Promise(function (resolve, reject) {
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function txDone(tx) {
  return new Promise(function (resolve, reject) {
    tx.oncomplete = function () { resolve(); };
    tx.onabort = function () { reject(tx.error || new Error('idb abort')); };
    tx.onerror = function () { reject(tx.error || new Error('idb error')); };
  });
}

function openDb() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open('esp-lkp', 1);
    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains('queue')) {
        db.createObjectStore('queue', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('sent')) {
        db.createObjectStore('sent', { keyPath: 'id' });
      }
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function db() {
  if (!dbPromise) {
    dbPromise = openDb().catch(function (err) {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

async function sha256(text) {
  var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(function (b) {
    return b.toString(16).padStart(2, '0');
  }).join('');
}

async function readSettings() {
  var stored = await chrome.storage.local.get({ cabinetHost: '', crmOrigin: '', token: '' });
  return {
    cabinetHost: EspLkp.normalizeCabinetHost(stored.cabinetHost),
    crmOrigin: EspLkp.normalizeCrmOrigin(stored.crmOrigin),
    token: EspLkp.normalizeToken(stored.token)
  };
}

async function readToken() {
  var settings = await readSettings();
  return settings.token;
}

async function hasOrigin(pattern) {
  if (!pattern) return false;
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch (e) {
    return false;
  }
}

async function readRules() {
  var stored = await chrome.storage.local.get({ specRules: null });
  if (Array.isArray(stored.specRules) && stored.specRules.length) return stored.specRules;
  return EspLkp.DEFAULT_RULES;
}

async function queueAll() {
  var database = await db();
  var tx = database.transaction('queue', 'readonly');
  var rows = await reqp(tx.objectStore('queue').getAll());
  await txDone(tx);
  return rows || [];
}

async function queueGet(id) {
  var database = await db();
  var tx = database.transaction('queue', 'readonly');
  var row = await reqp(tx.objectStore('queue').get(id));
  await txDone(tx);
  return row || null;
}

async function sentGet(id) {
  var database = await db();
  var tx = database.transaction('sent', 'readonly');
  var row = await reqp(tx.objectStore('sent').get(id));
  await txDone(tx);
  return row || null;
}

async function queuePut(row) {
  var database = await db();
  var tx = database.transaction('queue', 'readwrite');
  tx.objectStore('queue').put(row);
  await txDone(tx);
}

async function queueDelete(ids) {
  if (!ids.length) return;
  var database = await db();
  var tx = database.transaction('queue', 'readwrite');
  var store = tx.objectStore('queue');
  ids.forEach(function (id) { store.delete(id); });
  await txDone(tx);
}

async function rememberSent(ids) {
  if (!ids.length) return;
  var database = await db();
  var tx = database.transaction('sent', 'readwrite');
  var store = tx.objectStore('sent');
  var at = Date.now();
  ids.forEach(function (id) { store.put({ id: id, at: at }); });
  await txDone(tx);
}

async function pruneSent() {
  var database = await db();
  var tx = database.transaction('sent', 'readwrite');
  var store = tx.objectStore('sent');
  var rows = await reqp(store.getAll());
  var cutoff = Date.now() - SENT_TTL_MS;
  (rows || []).forEach(function (row) {
    if (!row || row.at < cutoff) store.delete(row.id);
  });
  await txDone(tx);
}

async function setError(text) {
  await chrome.storage.local.set({ lastError: text || '' });
}

async function markSent(summary) {
  await chrome.storage.local.set({
    lastError: '',
    lastSentAt: new Date().toISOString(),
    lastSummary: summary || ''
  });
}

async function setBadge(waiting, parked) {
  var text = waiting > 0 ? String(Math.min(waiting, 99)) : '';
  await chrome.action.setBadgeText({ text: text });
  await chrome.action.setBadgeBackgroundColor({ color: parked > 0 && !waiting ? '#b91c1c' : '#0f766e' });
}

async function counts() {
  var rows = await queueAll();
  var waiting = 0;
  var parked = 0;
  rows.forEach(function (row) {
    if (row && row.parked) parked += 1;
    else waiting += 1;
  });
  return { waiting: waiting, parked: parked, rows: rows };
}

async function refreshBadge() {
  var c = await counts();
  await setBadge(c.waiting, c.parked);
  return c;
}

function scheduleRetry() {
  chrome.alarms.create(ALARM, { delayInMinutes: 1 });
}

function captureLabel(item) {
  try {
    var url = new URL(item.url);
    var extra = [];
    ['inn', 'cashdeskId', 'offset', 'limit'].forEach(function (key) {
      var value = url.searchParams.get(key);
      if (value) extra.push(key + '=' + value);
    });
    return (item.method || 'GET') + ' ' + url.pathname + (extra.length ? '?' + extra.join('&') : '');
  } catch (e) {
    return item && item.method ? item.method : 'GET';
  }
}

function logLine(line) {
  console.log('[ЕСП→CRM]', line);
  readSettings().then(function (settings) {
    if (!settings.cabinetHost) return [];
    return chrome.tabs.query({ url: 'https://' + settings.cabinetHost + '/*' });
  }).then(function (tabs) {
    (tabs || []).forEach(function (tab) {
      if (!tab.id) return;
      chrome.tabs.sendMessage(tab.id, { type: 'log', line: line }).catch(function () {});
    });
  }).catch(function () {});
}

function crmHeaders(token, json) {
  var headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/json'
  };
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

async function crmFetch(url, token, options) {
  var init = options || {};
  var res = await fetch(url, {
    method: init.method || 'GET',
    headers: crmHeaders(token, !!init.body),
    body: init.body || undefined,
    credentials: 'omit',
    redirect: 'manual',
    cache: 'no-store',
    referrerPolicy: 'no-referrer'
  });
  if (res.type === 'opaqueredirect' || res.status === 0 || (res.status >= 300 && res.status < 400)) {
    return { status: null, data: { message: 'CRM недоступна' } };
  }
  var text = await res.text();
  var data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (e) { data = { message: text.slice(0, 300) }; }
  }
  return { status: res.status, data: data };
}

async function refreshSpec(force) {
  var settings = await readSettings();
  var token = settings.token;
  var endpoint = EspLkp.crmEndpoint(settings.crmOrigin, 'spec');
  if (!token || !endpoint) return;
  if (!await hasOrigin(settings.crmOrigin + '/*')) {
    logLine('нет доступа Chrome к приёму, сохраните настройки ещё раз');
    return;
  }
  var stored = await chrome.storage.local.get({ specFetchedAt: 0 });
  if (!force && stored.specFetchedAt && Date.now() - stored.specFetchedAt < SPEC_TTL_MS) return;
  try {
    var res = await crmFetch(endpoint, token);
    if (res.status === 401 || res.status === 403) {
      await setError('CRM не приняла токен (HTTP ' + res.status + ')');
      logLine('CRM не приняла токен (HTTP ' + res.status + ')');
      return;
    }
    if (res.status < 200 || res.status >= 300) {
      logLine('spec CRM: HTTP ' + res.status);
      return;
    }
    var rules = EspLkp.rulesFromSpec(res.data);
    if (!rules || !rules.length) {
      logLine('spec CRM без списка путей, остаётся встроенный');
      return;
    }
    logLine('список путей CRM: ' + rules.length);
    var prev = await chrome.storage.local.get({ lastError: '' });
    var patch = { specRules: rules, specFetchedAt: Date.now() };
    if (/токен/i.test(prev.lastError || '')) patch.lastError = '';
    await chrome.storage.local.set(patch);
  } catch (e) { /* остаётся прошлый список */ }
}

async function refreshStatus() {
  var settings = await readSettings();
  var token = settings.token;
  var endpoint = EspLkp.crmEndpoint(settings.crmOrigin, 'status');
  if (!settings.cabinetHost) {
    await chrome.storage.local.set({ statusLine: 'Укажите домен кабинета в настройках' });
    return;
  }
  if (!token || !endpoint) {
    await chrome.storage.local.set({ statusLine: 'Нужны адрес приёма и токен' });
    return;
  }
  if (!await hasOrigin(settings.crmOrigin + '/*')) {
    await chrome.storage.local.set({ statusLine: 'Chrome ещё не разрешил доступ к приёму' });
    return;
  }
  try {
    var res = await crmFetch(endpoint, token);
    if (res.status === 401 || res.status === 403) {
      await setError('CRM не приняла токен (HTTP ' + res.status + ')');
      await chrome.storage.local.set({ statusLine: 'CRM не приняла токен' });
      logLine('CRM не приняла токен (HTTP ' + res.status + ')');
      return;
    }
    if (res.status < 200 || res.status >= 300) {
      await chrome.storage.local.set({
        statusLine: 'Статус CRM: HTTP ' + res.status
      });
      return;
    }
    var line = EspLkp.statusSummary(res.data) || 'снимок принят';
    logLine('последний снимок CRM: ' + line);
    var prevStatus = await chrome.storage.local.get({ lastError: '' });
    var statusPatch = { statusLine: line, statusAt: new Date().toISOString() };
    if (/токен/i.test(prevStatus.lastError || '')) statusPatch.lastError = '';
    await chrome.storage.local.set(statusPatch);
  } catch (e) {
    await chrome.storage.local.set({ statusLine: 'CRM недоступна' });
  }
}

async function snapshot() {
  var settings = await readSettings();
  var stored = await chrome.storage.local.get({
    lastError: '',
    lastSentAt: '',
    lastSummary: '',
    statusLine: '',
    specRules: null,
    specFetchedAt: 0,
    unknownPaths: []
  });
  var c = { waiting: 0, parked: 0 };
  try { c = await refreshBadge(); } catch (e) { /* очередь недоступна */ }
  var serverRules = Array.isArray(stored.specRules) && stored.specRules.length;
  return {
    tokenSet: !!settings.token,
    cabinetHost: settings.cabinetHost,
    crmOrigin: settings.crmOrigin,
    accessCabinet: await hasOrigin(settings.cabinetHost ? 'https://' + settings.cabinetHost + '/*' : ''),
    accessCrm: await hasOrigin(settings.crmOrigin ? settings.crmOrigin + '/*' : ''),
    queue: c.waiting,
    parked: c.parked,
    lastError: stored.lastError || '',
    lastSentAt: stored.lastSentAt || '',
    lastSummary: stored.lastSummary || '',
    statusLine: stored.statusLine || '',
    specCount: serverRules ? stored.specRules.length : EspLkp.DEFAULT_RULES.length,
    specSource: serverRules ? 'server' : 'builtin',
    unknownPaths: stored.unknownPaths || [],
    version: chrome.runtime.getManifest().version
  };
}

function senderHost(sender) {
  if (!sender || !sender.tab || !sender.url) return '';
  try {
    return new URL(sender.url).hostname;
  } catch (e) {
    return '';
  }
}

function fromPopup(sender) {
  return !!(sender && sender.url && sender.url.indexOf(chrome.runtime.getURL('')) === 0);
}

async function onCapture(capture, settings) {
  var rules = await readRules();
  var prepared = EspLkp.prepareCapture(capture, rules, settings.cabinetHost);
  if (!prepared.ok) {
    if (prepared.reason === 'path' || prepared.reason === 'note') {
      try {
        var missed = new URL(capture.url);
        await notePath(capture.method, missed.pathname, '');
      } catch (e) { /* чужой адрес */ }
    }
    return;
  }
  var id = await sha256(prepared.dedupeKey);
  var name = captureLabel(prepared.capture);
  if (await sentGet(id)) {
    logLine('тот же снимок уже уходил в CRM · ' + name);
    return;
  }
  var existing = await queueGet(id);
  if (existing) {
    logLine('снимок уже в очереди · ' + name);
    return;
  }
  await queuePut({
    id: id,
    url: prepared.capture.url,
    method: prepared.capture.method,
    status: prepared.capture.status,
    page_url: prepared.capture.page_url,
    captured_at: prepared.capture.captured_at,
    body: prepared.capture.body,
    bytes: EspLkp.byteLength(JSON.stringify(prepared.capture.body)),
    queued_at: Date.now(),
    attempts: 0,
    parked: false
  });
  logLine('в очереди · ' + name + ' · ' + EspLkp.byteLength(JSON.stringify(prepared.capture.body)) + ' Б');
  await refreshBadge();
  flush();
}

async function notePath(method, path, note, settings) {
  var rules = await readRules();
  var decision = EspLkp.classify('https://' + settings.cabinetHost + path, method, rules, settings.cabinetHost);
  if (decision.action === 'capture' && note !== 'too-big') return;
  if (decision.action === 'drop') return;
  var stored = await chrome.storage.local.get({ unknownPaths: [] });
  var next = EspLkp.rememberPath(stored.unknownPaths, {
    method: method,
    path: path,
    note: note
  });
  await chrome.storage.local.set({ unknownPaths: next });
}

async function postBatch(token, endpoint, batch) {
  var version = chrome.runtime.getManifest().version;
  return crmFetch(endpoint, token, {
    method: 'POST',
    body: JSON.stringify({
      source: 'extension',
      extension_version: version,
      captures: batch.map(function (item) {
        return {
          url: item.url,
          method: item.method,
          status: item.status,
          page_url: item.page_url,
          captured_at: item.captured_at,
          body: item.body
        };
      })
    })
  });
}

async function parkItem(item, error) {
  item.parked = true;
  item.parkError = error || '';
  await queuePut(item);
  await setError(error || 'CRM отклонила снимок');
}

async function flushLoop() {
  var isolate = false;
  while (true) {
    var settings = await readSettings();
    var token = settings.token;
    var endpoint = EspLkp.crmEndpoint(settings.crmOrigin, 'capture');
    if (!settings.cabinetHost || !settings.crmOrigin) {
      pauseAlarm = true;
      await setError('Укажите домен кабинета и адрес приёма в настройках');
      return 'later';
    }
    if (!token || !endpoint) {
      pauseAlarm = true;
      await setError('Вставьте токен приёма в настройках');
      var pending = await counts();
      if (pending.waiting > 0) logLine('токен приёма не задан, в очереди ' + pending.waiting);
      return 'later';
    }
    if (!await hasOrigin(settings.crmOrigin + '/*')) {
      pauseAlarm = true;
      await setError('Chrome не разрешил доступ к приёму. Откройте настройки и сохраните ещё раз');
      logLine('нет доступа Chrome к ' + settings.crmOrigin);
      return 'later';
    }
    var c = await counts();
    var batch = EspLkp.selectBatch(c.rows, { maxCount: isolate ? 1 : EspLkp.MAX_BATCH });
    if (!batch.length) return 'idle';
    logLine('отправляю в приём ' + batch.length + ' · ' + batch.map(captureLabel).join(' · '));
    var res;
    try {
      res = await postBatch(token, endpoint, batch);
    } catch (e) {
      await setError('CRM недоступна');
      logLine('CRM недоступна, снимок остаётся в очереди');
      return 'later';
    }
    var verdict = EspLkp.interpretCaptureResponse(res.status, res.data, batch.length);
    if (verdict.kind === 'done') {
      if (verdict.drop <= 0) {
        await setError(verdict.error || 'CRM не подтвердила приём');
        return 'later';
      }
      var done = batch.slice(0, verdict.drop);
      await queueDelete(done.map(function (item) { return item.id; }));
      await rememberSent(done.map(function (item) { return item.id; }));
      await markSent(verdict.summary);
      logLine('CRM приняла ' + verdict.drop + (verdict.summary ? ' · ' + verdict.summary : ''));
      isolate = false;
      continue;
    }
    if (verdict.kind === 'token') {
      pauseAlarm = true;
      await setError(verdict.error);
      logLine(verdict.error);
      return 'later';
    }
    if (verdict.kind === 'retry') {
      await setError(verdict.error);
      logLine((verdict.error || 'CRM недоступна') + ', повтор позже');
      return 'later';
    }
    if (verdict.kind === 'split' && batch.length > 1 && !isolate) {
      isolate = true;
      continue;
    }
    await setError(verdict.error);
    if (batch.length > 1 && !isolate) {
      isolate = true;
      continue;
    }
    var attempts = (batch[0].attempts || 0) + 1;
    if (attempts >= EspLkp.PARK_AFTER) {
      await parkItem(batch[0], verdict.error);
      logLine('CRM отклонила снимок, больше не шлю · ' + captureLabel(batch[0]));
      isolate = false;
      continue;
    }
    batch[0].attempts = attempts;
    await queuePut(batch[0]);
    return 'later';
  }
}

async function flush() {
  if (flushing) {
    flushAgain = true;
    return;
  }
  flushing = true;
  pauseAlarm = false;
  var how = 'later';
  try {
    await pruneSent();
    how = 'idle';
    do {
      flushAgain = false;
      how = await flushLoop();
    } while (flushAgain && how === 'idle');
  } catch (e) {
    how = 'later';
    await setError('Очередь не отправилась');
  } finally {
    flushing = false;
    var c = { waiting: 0 };
    try { c = await refreshBadge(); } catch (e) { /* очередь недоступна */ }
    if (c.waiting > 0 && !pauseAlarm) scheduleRetry();
    else chrome.alarms.clear(ALARM);
    if (flushAgain && how === 'idle') flush();
  }
}

async function ensureScripts() {
  var settings = await readSettings();
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ['esp-lkp-main', 'esp-lkp-bridge'] });
  } catch (e) { /* скрипты ещё не регистрировали */ }
  if (!settings.cabinetHost) return;
  var pattern = 'https://' + settings.cabinetHost + '/*';
  if (!await hasOrigin(pattern)) {
    logLine('нет доступа Chrome к ' + settings.cabinetHost + ', сохраните настройки ещё раз');
    return;
  }
  try {
    await chrome.scripting.registerContentScripts([
      {
        id: 'esp-lkp-main',
        matches: [pattern],
        js: ['lib.js', 'hook.js'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: true,
        persistAcrossSessions: true
      },
      {
        id: 'esp-lkp-bridge',
        matches: [pattern],
        js: ['bridge.js'],
        runAt: 'document_start',
        world: 'ISOLATED',
        allFrames: true,
        persistAcrossSessions: true
      }
    ]);
  } catch (e) {
    logLine('не удалось включить перехват на ' + settings.cabinetHost);
    return;
  }
  logLine('слежу за ' + settings.cabinetHost);
}

async function injectOpenTabs() {
  var settings = await readSettings();
  if (!settings.cabinetHost) return;
  var tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: 'https://' + settings.cabinetHost + '/*' });
  } catch (e) {
    return;
  }
  for (var i = 0; i < tabs.length; i++) {
    if (!tabs[i].id) continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabs[i].id, allFrames: true },
        files: ['lib.js', 'hook.js'],
        world: 'MAIN'
      });
      await chrome.scripting.executeScript({
        target: { tabId: tabs[i].id, allFrames: true },
        files: ['bridge.js']
      });
    } catch (e) { /* вкладка уже закрыта */ }
  }
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;
  if (msg.type === 'capture' || msg.type === 'pathSeen') {
    readSettings().then(function (settings) {
      if (!settings.cabinetHost || senderHost(sender) !== settings.cabinetHost) {
        sendResponse({ ok: false });
        return;
      }
      var job = msg.type === 'capture'
        ? onCapture(msg.capture, settings)
        : notePath(msg.method, msg.path, msg.note, settings);
      job.then(function () { sendResponse({ ok: true }); }, function () { sendResponse({ ok: false }); });
    });
    return true;
  }
  if (!fromPopup(sender)) return;
  if (msg.type === 'getState') {
    refreshSpec(false);
    flush();
    snapshot().then(sendResponse);
    return true;
  }
  if (msg.type === 'refreshStatus') {
    refreshStatus().then(snapshot).then(sendResponse);
    return true;
  }
  if (msg.type === 'saveSettings') {
    var host = EspLkp.normalizeCabinetHost(msg.cabinetHost);
    var crm = EspLkp.normalizeCrmOrigin(msg.crmOrigin);
    if (!host || !crm) {
      sendResponse({ ok: false, error: 'Укажите домен кабинета и https-адрес приёма' });
      return;
    }
    var patch = { cabinetHost: host, crmOrigin: crm };
    if (msg.token) {
      var token = EspLkp.normalizeToken(msg.token);
      if (!token) {
        sendResponse({ ok: false, error: 'В токене есть пробел или он пустой' });
        return;
      }
      patch.token = token;
    }
    if (msg.clearToken) patch.token = '';
    chrome.storage.local.set(patch).then(function () {
      return ensureScripts();
    }).then(function () {
      return injectOpenTabs();
    }).then(function () {
      return refreshSpec(true);
    }).then(function () {
      flush();
      return snapshot();
    }).then(function (state) {
      sendResponse({ ok: true, state: state });
    });
    return true;
  }
  if (msg.type === 'clearToken') {
    chrome.storage.local.remove('token').then(snapshot).then(function (state) {
      sendResponse({ ok: true, state: state });
    });
    return true;
  }
});

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (!alarm || alarm.name !== ALARM) return;
  refreshSpec(false);
  flush();
});

function boot() {
  ensureScripts().then(injectOpenTabs).then(function () {
    refreshSpec(false);
    flush();
  });
}

chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);
