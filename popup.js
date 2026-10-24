var hostEl = document.getElementById('host');
var crmEl = document.getElementById('crm');
var queueEl = document.getElementById('queue');
var sentEl = document.getElementById('sent');
var statusEl = document.getElementById('status');
var errorEl = document.getElementById('error');
var unknownEl = document.getElementById('unknown');
var pathsEl = document.getElementById('paths');
var footEl = document.getElementById('foot');

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

function formatWhen(iso) {
  if (!iso) return 'ещё не было';
  var date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function paint(state) {
  if (!state) return;
  console.log(
    '[ЕСП→CRM]',
    'окно: домен ' + (state.cabinetHost || 'не задан') +
      ', приём ' + (state.crmOrigin || 'не задан') +
      ', очередь ' + (state.queue || 0) +
      ', токен ' + (state.tokenSet ? 'задан' : 'нет') +
      (state.lastError ? ', ошибка: ' + state.lastError : '')
  );
  hostEl.textContent = state.cabinetHost
    ? state.cabinetHost + (state.accessCabinet ? '' : ' · нет доступа')
    : 'не задан';
  crmEl.textContent = state.crmOrigin
    ? state.crmOrigin.replace(/^https:\/\//, '') + (state.accessCrm ? '' : ' · нет доступа')
    : 'не задан';
  var waiting = state.queue || 0;
  var parked = state.parked || 0;
  queueEl.textContent = waiting
    ? (waiting + ' ждут отправки' + (parked ? ', ' + parked + ' отклонено' : ''))
    : (parked ? parked + ' отклонено' : 'пусто');
  var sent = formatWhen(state.lastSentAt);
  sentEl.textContent = state.lastSummary ? sent + ' · ' + state.lastSummary : sent;
  statusEl.textContent = state.statusLine || 'ещё не спрашивали';
  if (state.lastError) {
    errorEl.hidden = false;
    errorEl.textContent = state.lastError;
  } else {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }
  var paths = state.unknownPaths || [];
  unknownEl.hidden = paths.length === 0;
  pathsEl.replaceChildren();
  paths.forEach(function (row) {
    var li = document.createElement('li');
    var note = row.note === 'too-big' ? ' · больше 1,5 МБ' : '';
    li.textContent = row.method + ' ' + row.path + note;
    pathsEl.appendChild(li);
  });
  var source = state.specSource === 'server' ? 'список приёма' : 'встроенный список';
  footEl.textContent = 'Путей к отправке: ' + (state.specCount || 0) + ' (' + source + ')' +
    ' · ' + (state.version || '') +
    '. После смены домена обновите вкладку кабинета.';
}

document.getElementById('settings').addEventListener('click', function () {
  chrome.runtime.openOptionsPage();
});

send({ type: 'getState' }).then(function (state) {
  paint(state);
  return send({ type: 'refreshStatus' });
}).then(paint).catch(function () {
  errorEl.hidden = false;
  errorEl.textContent = 'Фон расширения не ответил. Откройте окно ещё раз.';
});
