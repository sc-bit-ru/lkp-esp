var hostInput = document.getElementById('host');
var crmInput = document.getElementById('crm');
var tokenInput = document.getElementById('token');
var saveBtn = document.getElementById('save');
var forgetBtn = document.getElementById('forget');
var msgEl = document.getElementById('msg');

function show(text, kind) {
  msgEl.textContent = text;
  msgEl.className = kind || '';
}

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

async function paint() {
  var state = await send({ type: 'getState' });
  if (!state) return;
  hostInput.value = state.cabinetHost || '';
  crmInput.value = state.crmOrigin || '';
  var access = [];
  if (state.cabinetHost) access.push(state.accessCabinet ? 'кабинет разрешён' : 'кабинет без доступа Chrome');
  if (state.crmOrigin) access.push(state.accessCrm ? 'приём разрешён' : 'приём без доступа Chrome');
  show(
    (state.tokenSet ? 'Токен сохранён в этом браузере.' : 'Токен ещё не задан.') +
      (access.length ? '\n' + access.join(', ') + '.' : '') +
      (state.cabinetHost ? '\nДомен: ' + state.cabinetHost : '') +
      (state.crmOrigin ? '\nПриём: ' + state.crmOrigin : ''),
    state.accessCabinet && state.accessCrm && state.tokenSet ? 'ok' : ''
  );
}

saveBtn.addEventListener('click', async function () {
  var host = EspLkp.normalizeCabinetHost(hostInput.value);
  var crm = EspLkp.normalizeCrmOrigin(crmInput.value);
  if (!host || !crm) {
    show('Нужен https-домен кабинета и https-адрес приёма. Порт, логин в адресе и звёздочки не подходят.', 'err');
    return;
  }
  saveBtn.disabled = true;
  try {
    var granted = await chrome.permissions.request({
      origins: ['https://' + host + '/*', crm + '/*']
    });
    if (!granted) {
      show('Chrome не выдал доступ. Без него расширение не видит кабинет и не зовёт приём.', 'err');
      return;
    }
    var prev = await send({ type: 'getState' });
    if (prev && prev.cabinetHost && prev.cabinetHost !== host) {
      await chrome.permissions.remove({ origins: ['https://' + prev.cabinetHost + '/*'] });
    }
    if (prev && prev.crmOrigin && prev.crmOrigin !== crm) {
      await chrome.permissions.remove({ origins: [prev.crmOrigin + '/*'] });
    }
    var msg = { type: 'saveSettings', cabinetHost: host, crmOrigin: crm };
    if (tokenInput.value.trim()) msg.token = tokenInput.value;
    var res = await send(msg);
    tokenInput.value = '';
    if (!res || !res.ok) {
      show((res && res.error) || 'Настройки не сохранились', 'err');
      return;
    }
    hostInput.value = res.state.cabinetHost || host;
    crmInput.value = res.state.crmOrigin || crm;
    show('Сохранено. Домен ' + host + ', приём ' + crm + '. Если вкладка кабинета уже открыта, обновите её один раз.', 'ok');
    console.log('[ЕСП→CRM]', 'настройки: домен ' + host + ', приём ' + crm);
  } catch (e) {
    show('Не удалось сохранить настройки', 'err');
  } finally {
    saveBtn.disabled = false;
  }
});

forgetBtn.addEventListener('click', async function () {
  forgetBtn.disabled = true;
  try {
    var res = await send({ type: 'clearToken' });
    tokenInput.value = '';
    show(res && res.state && res.state.tokenSet ? 'Токен на месте' : 'Токен удалён из этого браузера.', 'ok');
  } finally {
    forgetBtn.disabled = false;
  }
});

paint().catch(function () {
  show('Фон расширения не ответил. Закройте страницу и откройте настройки ещё раз.', 'err');
});
