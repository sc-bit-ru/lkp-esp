/* Копия ответа, который запросила страница. Новых запросов здесь нет. */
(function () {
  var api = globalThis.EspLkp;

  function hideApi() {
    try { delete globalThis.EspLkp; } catch (e) { /* already gone */ }
  }

  if (!api || globalThis.__espLkpHooked) {
    hideApi();
    return;
  }
  globalThis.__espLkpHooked = true;

  var classify = api.classify;
  var prepareBody = api.prepareBody;
  var nowIso = api.nowIso;
  var byteLength = api.byteLength;
  var maxBytes = api.MAX_BODY_BYTES;
  var rules = api.DEFAULT_RULES;
  var host = '';
  var pageLog = console.log.bind(console);

  function trace(line) {
    try { pageLog('[ЕСП→CRM]', line); } catch (e) { /* страница закрывается */ }
  }

  function label(method, url) {
    var path = url && url.pathname ? url.pathname : '';
    var extra = [];
    var keys = ['inn', 'cashdeskId', 'offset', 'limit'];
    for (var i = 0; i < keys.length; i++) {
      var value = url.searchParams.get(keys[i]);
      if (value) extra.push(keys[i] + '=' + value);
    }
    return String(method || 'GET').toUpperCase() + ' ' + path + (extra.length ? '?' + extra.join('&') : '');
  }

  function post(payload) {
    try {
      window.postMessage(payload, location.origin);
    } catch (e) { /* page is closing */ }
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var data = ev.data;
    if (!data || data.source !== 'esp-lkp-ext-bridge' || data.type !== 'config') return;
    if (Array.isArray(data.rules) && data.rules.length) rules = data.rules;
    host = String(data.host || '');
    trace('домен кабинета: ' + (host || 'не задан') + ', путей ' + rules.length);
  });

  function contentTypeOf(headersGetter) {
    try {
      return String(headersGetter() || '').toLowerCase();
    } catch (e) {
      return '';
    }
  }

  function isBinary(ct) {
    return /octet-stream|spreadsheet|excel|pdf|zip|image\/|audio\/|video\//.test(ct);
  }

  function notifyPath(method, path, note) {
    post({
      source: 'esp-lkp-ext',
      type: 'path',
      method: method,
      path: path,
      note: note || ''
    });
  }

  function emitCapture(method, abs, status, body) {
    var prepared = prepareBody(body);
    var name = label(method, abs);
    if (!prepared.ok) {
      if (prepared.reason === 'size') {
        trace('больше 1,5 МБ, в CRM не кладу · ' + name);
        notifyPath(method, abs.pathname, 'too-big');
      } else if (prepared.reason === 'auth-body') {
        trace('в теле токен, в CRM не кладу · ' + name);
      }
      return;
    }
    trace('копия ' + name + ' · HTTP ' + status);
    post({
      source: 'esp-lkp-ext',
      type: 'capture',
      url: abs.href,
      method: method,
      status: status,
      page_url: location.href,
      captured_at: nowIso(),
      body: prepared.body
    });
  }

  function parseText(text) {
    if (typeof text !== 'string') return text;
    var raw = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    return JSON.parse(raw);
  }

  function consider(method, urlString, status, ct, readText) {
    var abs;
    try {
      abs = new URL(urlString, location.href);
    } catch (e) {
      return;
    }
    if (!(status >= 200 && status < 300)) return;
    var decision = classify(abs.href, method, rules, host);
    if (decision.action === 'drop') {
      if (decision.reason === 'auth') trace('auth не отправляю · ' + label(method, abs));
      return;
    }
    if (decision.action === 'note') {
      if (ct.indexOf('json') !== -1) {
        trace('другой JSON, в CRM не шлю · ' + decision.method + ' ' + decision.path);
        notifyPath(decision.method, decision.path, '');
      }
      return;
    }
    if (isBinary(ct)) return;
    Promise.resolve()
      .then(readText)
      .then(function (text) {
        if (text == null) return;
        if (typeof text === 'string') {
          if (!text) return;
          if (byteLength(text) > maxBytes) {
            notifyPath(method, abs.pathname, 'too-big');
            return;
          }
        }
        var body;
        try {
          body = parseText(text);
        } catch (e) {
          trace('ответ не JSON · ' + label(method, abs));
          return;
        }
        emitCapture(String(method || 'GET').toUpperCase(), abs, status, body);
      })
      .catch(function () { /* ответ страницы уже у неё */ });
  }

  function requestUrl(input) {
    if (typeof input === 'string') return input;
    if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
    if (input && typeof input.url === 'string') return input.url;
    return '';
  }

  function requestMethod(input, init) {
    if (init && init.method) return String(init.method).toUpperCase();
    if (input && input.method) return String(input.method).toUpperCase();
    return 'GET';
  }

  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var method = requestMethod(input, init);
      var url = requestUrl(input);
      return origFetch.apply(this, arguments).then(function (resp) {
        try {
          consider(method, (resp && resp.url) || url, resp.status, contentTypeOf(function () {
            return resp.headers && resp.headers.get && resp.headers.get('content-type');
          }), function () {
            return resp.clone().text();
          });
        } catch (e) { /* не мешаем странице */ }
        return resp;
      });
    };
  }

  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__espLkp = { method: method, url: url };
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    var meta = this.__espLkp;
    if (meta) {
      this.addEventListener('load', function () {
        var xhr = this;
        var finalUrl = xhr.responseURL || meta.url;
        var ct = '';
        try { ct = xhr.getResponseHeader('content-type') || ''; } catch (e) { ct = ''; }
        consider(meta.method, finalUrl, xhr.status, String(ct).toLowerCase(), function () {
          var rt = xhr.responseType;
          if (rt === '' || rt === 'text') return xhr.responseText;
          if (rt === 'json') return xhr.response;
          if (rt === 'blob' && xhr.response && typeof xhr.response.text === 'function') {
            if (xhr.response.size > maxBytes) return Promise.resolve(null);
            return xhr.response.text();
          }
          if (rt === 'arraybuffer' && xhr.response) {
            if (xhr.response.byteLength > maxBytes) return Promise.resolve(null);
            return new TextDecoder().decode(xhr.response);
          }
          return null;
        });
      });
    }
    return origSend.apply(this, arguments);
  };

  trace('перехват включён, жду домен из настроек');
  hideApi();
})();
