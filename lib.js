(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.EspLkp = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CRM_PATHS = {
    capture: '/api/v2/ingest/esp-lkp/capture',
    spec: '/api/v2/ingest/esp-lkp/spec',
    status: '/api/v2/ingest/esp-lkp/status'
  };
  var MAX_BODY_BYTES = 1500000;
  var MAX_BATCH = 20;
  var PARK_AFTER = 5;
  var MAX_UNKNOWN = 20;

  var SECRET_KEYS = {
    accesstoken: 1,
    access_token: 1,
    refreshtoken: 1,
    refresh_token: 1,
    idtoken: 1,
    id_token: 1,
    password: 1,
    passwd: 1,
    pwd: 1,
    authorization: 1,
    cookie: 1,
    'set-cookie': 1
  };

  var DEFAULT_RULES = [
    { method: 'GET', path: '/api/v1/cashdesk/partner/aggregated_by_inn', query: [] },
    { method: 'GET', path: '/api/v1/cashdesk/partner/cashdesks', query: ['inn'] },
    { method: 'GET', path: '/api/v1/cashdesk/partner/counters', query: [] },
    { method: 'GET', path: '/api/v1/stats/history/cashdesk/last_component_report', query: ['cashdeskId'] },
    { method: 'GET', path: '/api/v1/stats/history/cashdesk/scan-counts', query: ['cashdeskId'] },
    { method: 'GET', path: '/api/v1/stats/history/cashdesk/mark-check-dates', query: ['cashdeskId'] },
    { method: 'GET', path: '/crm/api/tasks', query: [] },
    { method: 'GET', path: '/crm/api/tasks/{id}', query: [] }
  ];

  function nowIso(date) {
    var d = date || new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var tz = -d.getTimezoneOffset();
    var sign = tz >= 0 ? '+' : '-';
    var abs = Math.abs(tz);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
      sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60);
  }

  function byteLength(text) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(text)).length;
    return unescape(encodeURIComponent(String(text))).length;
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function pathToRegExp(path) {
    var re = /\{[^}/]+\}|:[A-Za-z_][A-Za-z0-9_]*/g;
    var out = '^';
    var last = 0;
    var m;
    while ((m = re.exec(path))) {
      out += escapeRegExp(path.slice(last, m.index));
      out += '[^/]+';
      last = m.index + m[0].length;
    }
    out += escapeRegExp(path.slice(last));
    return new RegExp(out + '$');
  }

  function normalizePathname(pathname) {
    var p = String(pathname || '');
    if (p.length > 1) p = p.replace(/\/+$/, '');
    return p;
  }

  function isAuthPath(pathname) {
    var parts = normalizePathname(pathname).toLowerCase().split('/');
    return parts.indexOf('auth') !== -1;
  }

  function normalizeToken(raw) {
    var t = String(raw || '').trim();
    t = t.replace(/^bearer\s+/i, '').trim();
    if (!t || /\s/.test(t)) return '';
    return t;
  }

  function asQueryList(value) {
    if (!value) return [];
    if (typeof value === 'string') return value ? [value] : [];
    if (Array.isArray(value)) {
      return value.map(function (item) {
        return typeof item === 'string' ? item : (item && item.name) || '';
      }).filter(Boolean);
    }
    if (typeof value === 'object') return Object.keys(value);
    return [];
  }

  function unique(list) {
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var key = list[i];
      if (!key || seen[key]) continue;
      seen[key] = 1;
      out.push(key);
    }
    return out;
  }

  function splitTarget(raw) {
    var s = String(raw || '').trim();
    var method = 'GET';
    var methodMatch = s.match(/^(GET|POST|PUT|PATCH|DELETE)\s+/i);
    if (methodMatch) {
      method = methodMatch[1].toUpperCase();
      s = s.slice(methodMatch[0].length).trim();
    }
    if (/^https?:\/\//i.test(s)) {
      try {
        var parsed = new URL(s);
        s = parsed.pathname + parsed.search;
      } catch (e) {
        return null;
      }
    }
    var qIndex = s.indexOf('?');
    var path = normalizePathname(qIndex === -1 ? s : s.slice(0, qIndex));
    var query = [];
    if (qIndex !== -1) {
      var sp = new URLSearchParams(s.slice(qIndex + 1));
      sp.forEach(function (_v, key) { query.push(key); });
    }
    if (!path || path.charAt(0) !== '/') return null;
    return { method: method, path: path, query: unique(query) };
  }

  function normalizeRule(item) {
    if (typeof item === 'string') return splitTarget(item);
    if (!item || typeof item !== 'object') return null;
    var rawPath = item.path || item.pathname || item.pattern || item.url;
    if (!rawPath || typeof rawPath !== 'string') return null;
    var parsed = splitTarget(rawPath);
    if (!parsed) return null;
    var method = String(item.method || item.httpMethod || parsed.method || 'GET').toUpperCase();
    var extra = item.query != null ? item.query : item.requiredQuery;
    return {
      method: method,
      path: parsed.path,
      query: unique(parsed.query.concat(asQueryList(extra)))
    };
  }

  function listFrom(data) {
    if (!data || typeof data !== 'object') return null;
    if (Array.isArray(data)) return data;
    var keys = ['paths', 'routes', 'endpoints', 'rules', 'items', 'allow'];
    for (var i = 0; i < keys.length; i++) {
      if (Array.isArray(data[keys[i]])) return data[keys[i]];
    }
    return null;
  }

  function rulesFromSpec(data, depth) {
    if (!data || typeof data !== 'object' || (depth || 0) > 3) return null;
    var list = listFrom(data);
    if (list) {
      var rules = [];
      for (var i = 0; i < list.length; i++) {
        var rule = normalizeRule(list[i]);
        if (rule) rules.push(rule);
      }
      if (rules.length) return rules;
    }
    if (data.data && data.data !== data) {
      var nested = rulesFromSpec(data.data, (depth || 0) + 1);
      if (nested && nested.length) return nested;
    }
    if (data.spec && data.spec !== data) {
      var fromSpec = rulesFromSpec(data.spec, (depth || 0) + 1);
      if (fromSpec && fromSpec.length) return fromSpec;
    }
    return null;
  }

  function compileRules(rules) {
    var source = rules && rules.length ? rules : DEFAULT_RULES;
    return source.map(function (rule) {
      return {
        method: rule.method || 'GET',
        path: rule.path,
        query: rule.query || [],
        re: pathToRegExp(rule.path)
      };
    });
  }

  function normalizeCabinetHost(raw) {
    var text = String(raw || '').trim();
    if (!text || text.indexOf('*') !== -1 || /\s/.test(text)) return '';
    if (text.indexOf('://') === -1) text = 'https://' + text;
    try {
      var url = new URL(text);
      if (url.protocol !== 'https:' || url.port || url.username || url.password) return '';
      if (!url.hostname || url.hostname.indexOf('.') === -1) return '';
      return url.hostname;
    } catch (e) {
      return '';
    }
  }

  function normalizeCrmOrigin(raw) {
    var text = String(raw || '').trim();
    if (!text || text.indexOf('*') !== -1 || /\s/.test(text)) return '';
    if (text.indexOf('://') === -1) text = 'https://' + text;
    try {
      var url = new URL(text);
      if (url.protocol !== 'https:' || url.port || url.username || url.password) return '';
      if (!url.hostname || url.hostname.indexOf('.') === -1) return '';
      return url.origin;
    } catch (e) {
      return '';
    }
  }

  function crmEndpoint(origin, kind) {
    var base = normalizeCrmOrigin(origin);
    var path = CRM_PATHS[kind];
    if (!base || !path) return '';
    return base + path;
  }

  function classify(urlString, method, rules, host) {
    host = normalizeCabinetHost(host);
    if (!host) return { action: 'drop', reason: 'host' };
    var url;
    try {
      url = new URL(String(urlString), 'https://' + host + '/');
    } catch (e) {
      return { action: 'drop', reason: 'url' };
    }
    if (url.protocol !== 'https:' || url.hostname !== host || url.port) {
      return { action: 'drop', reason: 'host' };
    }
    if (url.username || url.password) return { action: 'drop', reason: 'auth' };
    var path = normalizePathname(url.pathname);
    if (isAuthPath(path)) return { action: 'drop', reason: 'auth' };
    var want = String(method || 'GET').toUpperCase();
    var compiled = compileRules(rules);
    for (var i = 0; i < compiled.length; i++) {
      var rule = compiled[i];
      if (rule.method !== want) continue;
      if (!rule.re.test(path)) continue;
      var queryOk = true;
      for (var q = 0; q < rule.query.length; q++) {
        if (!url.searchParams.get(rule.query[q])) queryOk = false;
      }
      if (!queryOk) continue;
      return { action: 'capture', path: path, method: want };
    }
    return { action: 'note', reason: 'path', path: path, method: want };
  }

  function isAuthBody(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i].toLowerCase();
      if (k === 'accesstoken' || k === 'access_token' || k === 'refreshtoken' || k === 'refresh_token') {
        return true;
      }
    }
    return false;
  }

  function stripValue(value, depth) {
    if (depth > 12) return null;
    if (value === null) return null;
    var t = typeof value;
    if (t === 'string' || t === 'boolean') return value;
    if (t === 'number') return Number.isFinite(value) ? value : null;
    if (Array.isArray(value)) {
      return value.map(function (item) { return stripValue(item, depth + 1); });
    }
    if (t !== 'object') return null;
    var out = {};
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) {
      if (SECRET_KEYS[keys[i].toLowerCase()]) continue;
      out[keys[i]] = stripValue(value[keys[i]], depth + 1);
    }
    return out;
  }

  function prepareBody(body) {
    if (isAuthBody(body)) return { ok: false, reason: 'auth-body' };
    if (body === null || typeof body !== 'object') return { ok: false, reason: 'body' };
    var plain;
    try {
      plain = stripValue(body, 0);
      JSON.stringify(plain);
    } catch (e) {
      return { ok: false, reason: 'body' };
    }
    if (plain === null || typeof plain !== 'object') return { ok: false, reason: 'body' };
    if (byteLength(JSON.stringify(plain)) > MAX_BODY_BYTES) return { ok: false, reason: 'size' };
    return { ok: true, body: plain };
  }

  function stripSecretQuery(url) {
    var keys = [];
    url.searchParams.forEach(function (_v, key) { keys.push(key); });
    for (var i = 0; i < keys.length; i++) {
      if (SECRET_KEYS[keys[i].toLowerCase()] || keys[i].toLowerCase() === 'token') {
        url.searchParams.delete(keys[i]);
      }
    }
  }

  function safePageUrl(value, host) {
    host = normalizeCabinetHost(host);
    if (!value || !host) return '';
    try {
      var url = new URL(String(value));
      if (url.protocol !== 'https:' || url.hostname !== host || url.port) return '';
      url.username = '';
      url.password = '';
      url.hash = '';
      stripSecretQuery(url);
      return url.href;
    } catch (e) {
      return '';
    }
  }

  function canonicalUrl(value) {
    var url = new URL(String(value));
    url.hash = '';
    url.username = '';
    url.password = '';
    stripSecretQuery(url);
    var pairs = [];
    url.searchParams.forEach(function (v, k) { pairs.push([k, v]); });
    pairs.sort(function (a, b) {
      if (a[0] === b[0]) return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
      return a[0] < b[0] ? -1 : 1;
    });
    var sp = new URLSearchParams();
    for (var i = 0; i < pairs.length; i++) sp.append(pairs[i][0], pairs[i][1]);
    url.search = sp.toString();
    return url.href;
  }

  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
      return '[' + value.map(function (item) { return stableStringify(item); }).join(',') + ']';
    }
    var keys = Object.keys(value).sort();
    return '{' + keys.map(function (key) {
      return JSON.stringify(key) + ':' + stableStringify(value[key]);
    }).join(',') + '}';
  }

  function prepareCapture(input, rules, host) {
    if (!input || typeof input !== 'object') return { ok: false, reason: 'shape' };
    var method = String(input.method || 'GET').toUpperCase();
    var status = Number(input.status);
    if (!Number.isInteger(status) || status < 200 || status >= 300) return { ok: false, reason: 'status' };
    var url;
    try {
      url = new URL(String(input.url));
    } catch (e) {
      return { ok: false, reason: 'url' };
    }
    url.hash = '';
    url.username = '';
    url.password = '';
    stripSecretQuery(url);
    var decision = classify(url.href, method, rules, host);
    if (decision.action !== 'capture') return { ok: false, reason: decision.reason || decision.action };
    var prepared = prepareBody(input.body);
    if (!prepared.ok) return prepared;
    var capturedAt = typeof input.captured_at === 'string' && input.captured_at ? input.captured_at : nowIso();
    var capture = {
      url: url.href,
      method: method,
      status: status,
      page_url: safePageUrl(input.page_url, host),
      captured_at: capturedAt,
      body: prepared.body
    };
    return {
      ok: true,
      capture: capture,
      dedupeKey: method + '\n' + canonicalUrl(url.href) + '\n' + stableStringify(prepared.body)
    };
  }

  function selectBatch(items, opts) {
    var maxCount = Math.max(1, (opts && opts.maxCount) || MAX_BATCH);
    var maxBytes = (opts && opts.maxBytes) || (MAX_BODY_BYTES * MAX_BATCH);
    var list = (items || []).filter(function (item) { return item && !item.parked; });
    list.sort(function (a, b) { return (a.queued_at || 0) - (b.queued_at || 0); });
    var batch = [];
    var used = 0;
    for (var i = 0; i < list.length; i++) {
      if (batch.length >= maxCount) break;
      var size = list[i].bytes != null ? list[i].bytes : byteLength(JSON.stringify(list[i].body));
      if (batch.length > 0 && used + size > maxBytes) break;
      batch.push(list[i]);
      used += size;
    }
    return batch;
  }

  function messageOf(data) {
    if (!data) return '';
    if (typeof data === 'string') return data.slice(0, 300);
    if (typeof data.error === 'string') return data.error.slice(0, 300);
    if (typeof data.message === 'string') return data.message.slice(0, 300);
    return '';
  }

  function captureSummary(data) {
    if (!data || typeof data !== 'object') return '';
    var parts = [];
    if (data.accepted != null) parts.push('принято ' + data.accepted);
    if (data.ignored != null) parts.push('мимо ' + data.ignored);
    return parts.join(', ');
  }

  function interpretCaptureResponse(status, data, sentCount) {
    if (status == null || status === 0) {
      return { kind: 'retry', drop: 0, error: 'CRM недоступна', summary: '' };
    }
    if (status === 401 || status === 403) {
      return { kind: 'token', drop: 0, error: 'CRM не приняла токен (HTTP ' + status + ')', summary: '' };
    }
    if (status === 408 || status === 429 || status >= 500) {
      return { kind: 'retry', drop: 0, error: 'CRM временно недоступна (HTTP ' + status + ')', summary: '' };
    }
    if (status === 413) {
      return { kind: 'split', drop: 0, error: 'CRM не приняла размер пачки', summary: '' };
    }
    if (status < 200 || status >= 300) {
      return { kind: 'reject', drop: 0, error: messageOf(data) || ('HTTP ' + status), summary: '' };
    }
    if (data && data.ok === false) {
      var results = Array.isArray(data.results) ? data.results : null;
      if (results && results.length > 0) {
        return {
          kind: 'done',
          drop: Math.min(sentCount, results.length),
          error: null,
          summary: captureSummary(data)
        };
      }
      return { kind: 'reject', drop: 0, error: messageOf(data) || 'CRM отклонила пачку', summary: '' };
    }
    return { kind: 'done', drop: sentCount, error: null, summary: captureSummary(data) };
  }

  function statusSummary(data) {
    if (!data || typeof data !== 'object') return '';
    var preferred = [
      'last_capture_at', 'lastCaptureAt', 'last_snapshot_at', 'lastSnapshotAt',
      'captured_at', 'last_at', 'lastAcceptedAt', 'updated_at'
    ];
    for (var i = 0; i < preferred.length; i++) {
      if (data[preferred[i]]) return String(data[preferred[i]]);
    }
    var nestedKeys = ['data', 'status', 'snapshot'];
    for (var n = 0; n < nestedKeys.length; n++) {
      var child = data[nestedKeys[n]];
      if (child && typeof child === 'object') {
        var inner = statusSummary(child);
        if (inner) return inner;
      }
    }
    var parts = [];
    var keys = Object.keys(data);
    for (var k = 0; k < keys.length; k++) {
      var value = data[keys[k]];
      if (value == null || typeof value === 'object') continue;
      if (/token|password|authorization|cookie/i.test(keys[k])) continue;
      parts.push(keys[k] + ': ' + String(value).slice(0, 80));
    }
    return parts.slice(0, 6).join('\n');
  }

  function rememberPath(list, entry, limit) {
    var method = String((entry && entry.method) || 'GET').toUpperCase();
    var path = normalizePathname(entry && entry.path);
    if (!path || path.charAt(0) !== '/') return list || [];
    if (isAuthPath(path)) return list || [];
    var row = {
      method: method,
      path: path,
      at: (entry && entry.at) || nowIso(),
      note: entry && entry.note ? String(entry.note).slice(0, 40) : ''
    };
    var next = [row].concat((list || []).filter(function (item) {
      return !(item.method === method && item.path === path);
    }));
    return next.slice(0, limit || MAX_UNKNOWN);
  }

  return {
    MAX_BODY_BYTES: MAX_BODY_BYTES,
    MAX_BATCH: MAX_BATCH,
    PARK_AFTER: PARK_AFTER,
    MAX_UNKNOWN: MAX_UNKNOWN,
    DEFAULT_RULES: DEFAULT_RULES,
    nowIso: nowIso,
    byteLength: byteLength,
    isAuthPath: isAuthPath,
    normalizeToken: normalizeToken,
    normalizeCabinetHost: normalizeCabinetHost,
    normalizeCrmOrigin: normalizeCrmOrigin,
    crmEndpoint: crmEndpoint,
    rulesFromSpec: rulesFromSpec,
    classify: classify,
    prepareBody: prepareBody,
    prepareCapture: prepareCapture,
    selectBatch: selectBatch,
    interpretCaptureResponse: interpretCaptureResponse,
    statusSummary: statusSummary,
    captureSummary: captureSummary,
    canonicalUrl: canonicalUrl,
    stableStringify: stableStringify,
    rememberPath: rememberPath,
    safePageUrl: safePageUrl
  };
});
