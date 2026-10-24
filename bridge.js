/* Изолированный мост: в страницу токен не попадает, в CRM уходит только через service worker. */
(function () {
  if (globalThis.__espLkpBridge) return;
  globalThis.__espLkpBridge = true;

  var SOURCE = 'esp-lkp-ext';

  function deliver(msg, left) {
    try {
      chrome.runtime.sendMessage(msg, function () {
        var err = chrome.runtime.lastError;
        if (err && left > 0) setTimeout(function () { deliver(msg, left - 1); }, 400);
      });
    } catch (e) { /* worker ещё поднимается */ }
  }

  function pushConfig(host, rules) {
    window.postMessage({
      source: 'esp-lkp-ext-bridge',
      type: 'config',
      host: host || '',
      rules: rules || null
    }, location.origin);
  }

  function loadConfig() {
    chrome.storage.local.get({ cabinetHost: '', specRules: null }, function (res) {
      if (chrome.runtime.lastError) return;
      pushConfig(res.cabinetHost, res.specRules);
    });
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    if (ev.origin !== location.origin) return;
    var data = ev.data;
    if (!data || data.source !== SOURCE) return;
    if (data.type === 'capture') {
      deliver({
        type: 'capture',
        capture: {
          url: data.url,
          method: data.method,
          status: data.status,
          page_url: data.page_url,
          captured_at: data.captured_at,
          body: data.body
        }
      }, 2);
      return;
    }
    if (data.type === 'path') {
      deliver({
        type: 'pathSeen',
        method: data.method,
        path: data.path,
        note: data.note || ''
      }, 1);
    }
  });

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.type !== 'log' || typeof msg.line !== 'string') return;
    console.log('[ЕСП→CRM]', msg.line);
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (!changes.specRules && !changes.cabinetHost) return;
    loadConfig();
  });

  loadConfig();
})();
