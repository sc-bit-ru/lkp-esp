const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function boot(nativeFetch) {
  const messages = [];
  const calls = [];
  function XHR() {
    this.listeners = {};
    this.status = 200;
    this.responseURL = '';
    this.responseType = '';
    this.responseText = '';
    this.response = null;
  }
  XHR.prototype.open = function (method, url) {
    this._method = method;
    this._url = url;
  };
  XHR.prototype.send = function () {
    const target = new URL(this._url, 'https://lkp.ao-esp.ru/').href;
    this.responseURL = target;
    if (this.responseType === 'json') this.response = { items: [1] };
    else this.responseText = JSON.stringify({ items: [1] });
    (this.listeners.load || []).forEach((fn) => fn.call(this));
  };
  XHR.prototype.addEventListener = function (type, fn) {
    (this.listeners[type] || (this.listeners[type] = [])).push(fn);
  };
  XHR.prototype.getResponseHeader = function () { return 'application/json'; };

  const location = {
    href: 'https://lkp.ao-esp.ru/crm/',
    origin: 'https://lkp.ao-esp.ru'
  };
  const context = {
    Object, Array, String, Number, Boolean, JSON, Math, Date, RegExp, Error, TypeError,
    Promise, URL, URLSearchParams, TextEncoder, TextDecoder,
    parseInt, parseFloat, isNaN, isFinite, decodeURIComponent, encodeURIComponent,
    console, setTimeout, clearTimeout,
    location,
    XMLHttpRequest: XHR
  };
  context.globalThis = context;
  context.window = context;
  context.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    return nativeFetch(input, init, url);
  };
  context.postMessage = function (data, origin) {
    messages.push({ data: data, origin: origin });
  };
  context.__listeners = {};
  context.addEventListener = function (type, fn) {
    (context.__listeners[type] || (context.__listeners[type] = [])).push(fn);
  };
  vm.createContext(context);
  const root = path.join(__dirname, '..');
  vm.runInContext(fs.readFileSync(path.join(root, 'lib.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'hook.js'), 'utf8'), context);
  return { context: context, messages: messages, calls: calls };
}

function arm(page, host) {
  const win = vm.runInContext('window', page.context);
  (page.context.__listeners.message || []).forEach(function (fn) {
    fn({
      source: win,
      data: {
        source: 'esp-lkp-ext-bridge',
        type: 'config',
        host: host || 'lkp.ao-esp.ru',
        rules: null
      }
    });
  });
}

function jsonResponse(url, status, payload, contentType) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    url: url,
    status: status,
    headers: {
      get: function (name) {
        return String(name).toLowerCase() === 'content-type' ? (contentType || 'application/json') : null;
      }
    },
    clone: function () { return this; },
    text: function () { return Promise.resolve(text); }
  };
}

async function settle() {
  await new Promise(function (resolve) { setImmediate(resolve); });
  await new Promise(function (resolve) { setImmediate(resolve); });
}

test('перехват копирует ответ страницы и не делает второй запрос', async function () {
  const page = boot(function (_input, _init, url) {
    return Promise.resolve(jsonResponse(new URL(url, 'https://lkp.ao-esp.ru/').href, 200, { total: 4 }));
  });
  arm(page);
  const resp = await page.context.fetch('/api/v1/cashdesk/partner/counters');
  assert.equal(await resp.text(), '{"total":4}');
  await settle();
  assert.deepEqual(page.calls, ['/api/v1/cashdesk/partner/counters']);
  const captures = page.messages.filter(function (msg) { return msg.data.type === 'capture'; });
  assert.equal(captures.length, 1);
  assert.equal(captures[0].data.body.total, 4);
  assert.equal(captures[0].data.status, 200);
  assert.equal(JSON.stringify(captures[0].data).includes('authorization'), false);
  assert.equal(captures[0].origin, 'https://lkp.ao-esp.ru');
});

test('auth, чужой хост и ошибка не попадают в сообщения с телом', async function () {
  const page = boot(function (_input, _init, url) {
    const abs = new URL(url, 'https://lkp.ao-esp.ru/').href;
    const status = abs.includes('/missing') ? 404 : 200;
    return Promise.resolve(jsonResponse(abs, status, { accessToken: 'no', ok: true }));
  });
  arm(page);
  await page.context.fetch('/api/v1/portal/auth/login');
  await page.context.fetch('https://receiver.example/api/v2/ingest/esp-lkp/capture');
  await page.context.fetch('/api/v1/missing');
  await page.context.fetch('/billing/partnerarea/reward/report/summary');
  await settle();
  assert.equal(page.calls.length, 4);
  const captures = page.messages.filter(function (msg) { return msg.data.type === 'capture'; });
  assert.equal(captures.length, 0);
  const paths = page.messages.filter(function (msg) { return msg.data.type === 'path'; });
  assert.equal(paths.length, 1);
  assert.equal(paths[0].data.path, '/billing/partnerarea/reward/report/summary');
  assert.equal(JSON.stringify(page.messages).includes('accessToken'), false);
});

test('XHR страницы тоже снимается один раз', async function () {
  const page = boot(function () { throw new Error('fetch не должен вызываться'); });
  arm(page);
  const xhr = new page.context.XMLHttpRequest();
  xhr.open('GET', '/crm/api/tasks/42');
  xhr.responseType = 'json';
  xhr.send();
  await settle();
  assert.deepEqual(page.calls, []);
  const captures = page.messages.filter(function (msg) { return msg.data.type === 'capture'; });
  assert.equal(captures.length, 1);
  assert.equal(captures[0].data.url, 'https://lkp.ao-esp.ru/crm/api/tasks/42');
  assert.equal(JSON.stringify(captures[0].data.body), JSON.stringify({ items: [1] }));
});
