const test = require('node:test');
const assert = require('node:assert/strict');
const esp = require('../lib.js');

const RULES = esp.DEFAULT_RULES;
const CABINET = 'lkp.ao-esp.ru';
const rawClassify = esp.classify;
const rawPrepare = esp.prepareCapture;
esp.classify = function (url, method, rules, host) {
  if (arguments.length < 4) host = CABINET;
  return rawClassify(url, method, rules, host);
};
esp.prepareCapture = function (input, rules, host) {
  if (arguments.length < 3) host = CABINET;
  return rawPrepare(input, rules, host);
};

const SAMPLES = [
  'https://lkp.ao-esp.ru/api/v1/cashdesk/partner/aggregated_by_inn?limit=100&offset=0',
  'https://lkp.ao-esp.ru/api/v1/cashdesk/partner/cashdesks?inn=0000000000&limit=100&offset=0',
  'https://lkp.ao-esp.ru/api/v1/cashdesk/partner/counters',
  'https://lkp.ao-esp.ru/api/v1/stats/history/cashdesk/last_component_report?cashdeskId=15',
  'https://lkp.ao-esp.ru/api/v1/stats/history/cashdesk/scan-counts?cashdeskId=15',
  'https://lkp.ao-esp.ru/api/v1/stats/history/cashdesk/mark-check-dates?cashdeskId=15',
  'https://lkp.ao-esp.ru/crm/api/tasks?limit=50',
  'https://lkp.ao-esp.ru/crm/api/tasks/88421'
];

function capture(url, body, extra) {
  return esp.prepareCapture(Object.assign({
    url: url,
    method: 'GET',
    status: 200,
    page_url: 'https://lkp.ao-esp.ru/crm/',
    captured_at: '2026-10-24T14:30:00+07:00',
    body: body == null ? { ok: true } : body
  }, extra || {}), RULES);
}

test('домен и адрес приёма задаются явно', function () {
  assert.equal(esp.normalizeCabinetHost('lkp.ao-esp.ru'), CABINET);
  assert.equal(esp.normalizeCabinetHost('https://LKP.AO-ESP.RU/crm/#/dg'), CABINET);
  assert.equal(esp.normalizeCabinetHost('http://lkp.ao-esp.ru'), '');
  assert.equal(esp.normalizeCabinetHost('https://user:secret@lkp.ao-esp.ru'), '');
  assert.equal(esp.normalizeCabinetHost('https://lkp.ao-esp.ru:8443'), '');
  assert.equal(esp.normalizeCabinetHost('*.ao-esp.ru'), '');
  assert.equal(esp.normalizeCrmOrigin('receiver.example/api/v2'), 'https://receiver.example');
  assert.equal(esp.normalizeCrmOrigin('http://receiver.example'), '');
  assert.equal(
    esp.crmEndpoint('https://crm.example.test/ignored', 'capture'),
    'https://crm.example.test/api/v2/ingest/esp-lkp/capture'
  );
  assert.equal(rawClassify(SAMPLES[2], 'GET', RULES, '').action, 'drop');
  assert.equal(rawClassify(SAMPLES[2], 'GET', RULES, 'other.example').action, 'drop');
  assert.equal(rawClassify(SAMPLES[2], 'GET', RULES, CABINET).action, 'capture');
});

test('встроенный список — восемь путей из задания', function () {
  assert.equal(RULES.length, 8);
  SAMPLES.forEach(function (url) {
    assert.equal(esp.classify(url, 'GET', RULES).action, 'capture', url);
    assert.equal(capture(url).ok, true, url);
  });
});

test('spec CRM перекрывает встроенный список', function () {
  const rules = esp.rulesFromSpec({
    ok: true,
    paths: [
      'GET /api/v1/cashdesk/partner/aggregated_by_inn',
      'GET /api/v1/cashdesk/partner/cashdesks?inn=',
      'GET /api/v1/cashdesk/partner/counters',
      'GET /api/v1/stats/history/cashdesk/last_component_report?cashdeskId=',
      'GET /api/v1/stats/history/cashdesk/scan-counts?cashdeskId=',
      'GET /api/v1/stats/history/cashdesk/mark-check-dates?cashdeskId=',
      'GET /crm/api/tasks',
      { method: 'GET', path: '/crm/api/tasks/{id}', kind: 'task' }
    ]
  });
  assert.equal(rules.length, 8);
  assert.equal(esp.classify(SAMPLES[1], 'GET', rules).action, 'capture');
  assert.equal(esp.classify('https://lkp.ao-esp.ru/api/v1/cashdesk/partner/cashdesks?limit=10', 'GET', rules).action, 'note');
  const wrapped = esp.rulesFromSpec({ data: { routes: rules } });
  assert.equal(wrapped.length, 8);
});

test('чужой хост, порт, auth и не-JSON статуса не уходят', function () {
  assert.equal(esp.classify('https://evil.example/api/v1/cashdesk/partner/counters', 'GET', RULES).action, 'drop');
  assert.equal(esp.classify('https://lkp.ao-esp.ru.evil.com/api/v1/cashdesk/partner/counters', 'GET', RULES).action, 'drop');
  assert.equal(esp.classify('https://sub.lkp.ao-esp.ru/api/v1/cashdesk/partner/counters', 'GET', RULES).action, 'drop');
  assert.equal(esp.classify('http://lkp.ao-esp.ru/api/v1/cashdesk/partner/counters', 'GET', RULES).action, 'drop');
  assert.equal(esp.classify('https://lkp.ao-esp.ru:444/api/v1/cashdesk/partner/counters', 'GET', RULES).action, 'drop');
  assert.equal(esp.classify('https://user:secret@lkp.ao-esp.ru/api/v1/cashdesk/partner/counters', 'GET', RULES).action, 'drop');
  assert.equal(esp.classify('https://lkp.ao-esp.ru/api/v1/portal/auth/login', 'GET', RULES).action, 'drop');
  assert.equal(esp.classify('https://lkp.ao-esp.ru/api/v1/portal/auth/refresh', 'POST', RULES).action, 'drop');
  assert.equal(esp.isAuthPath('/auth/'), true);
  assert.equal(capture(SAMPLES[2], { ok: true }, { status: 401 }).ok, false);
  assert.equal(capture(SAMPLES[2], { ok: true }, { status: 500 }).ok, false);
  const authBody = capture(SAMPLES[2], { accessToken: 'a', refreshToken: 'b', user: 'x' });
  assert.equal(authBody.ok, false);
  assert.equal(authBody.reason, 'auth-body');
});

test('кассы без inn, карточка заявки и чужие пути', function () {
  assert.equal(esp.classify('https://lkp.ao-esp.ru/api/v1/cashdesk/partner/cashdesks?limit=100', 'GET', RULES).action, 'note');
  assert.equal(esp.classify('https://lkp.ao-esp.ru/crm/api/tasks/88421/comments', 'GET', RULES).action, 'note');
  assert.equal(esp.classify('https://lkp.ao-esp.ru/billing/partnerarea/reward/report/summary', 'GET', RULES).action, 'note');
  assert.equal(esp.classify('https://lkp.ao-esp.ru/crm/api/tasks/', 'GET', RULES).action, 'capture');
  assert.equal(esp.classify(SAMPLES[7], 'POST', RULES).action, 'note');
});

test('из тела уходят пароль и токен в query, страница чужого хоста не прикладывается', function () {
  const prepared = capture(SAMPLES[0], {
    inn: '0000000000',
    user: { name: 'Кассир', password: 'secret', cookie: 'a=b' }
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.capture.body.user.password, undefined);
  assert.equal(prepared.capture.body.user.cookie, undefined);
  assert.equal(prepared.capture.body.user.name, 'Кассир');
  assert.equal(prepared.capture.body.inn, '0000000000');

  const withToken = capture(
    'https://lkp.ao-esp.ru/api/v1/cashdesk/partner/counters?access_token=SECRET&x=1',
    { n: 1 },
    { page_url: 'https://evil.example/phish' }
  );
  assert.equal(withToken.ok, true);
  assert.equal(withToken.capture.url.includes('SECRET'), false);
  assert.equal(withToken.capture.url.includes('access_token'), false);
  assert.equal(withToken.capture.url.includes('x=1'), true);
  assert.equal(withToken.capture.page_url, '');
  assert.equal(JSON.stringify(withToken.capture).includes('SECRET'), false);
});

test('один и тот же снимок даёт один ключ', function () {
  const left = capture(SAMPLES[1], { b: 1, a: { z: 1, y: 2 } });
  const right = capture(
    'https://lkp.ao-esp.ru/api/v1/cashdesk/partner/cashdesks?offset=0&limit=100&inn=0000000000',
    { a: { y: 2, z: 1 }, b: 1 }
  );
  assert.equal(left.dedupeKey, right.dedupeKey);
});

test('пачка не больше 20 и режется по размеру', function () {
  const many = [];
  for (let i = 0; i < 25; i++) many.push({ id: i, queued_at: i, body: { i: i }, parked: i === 3 });
  assert.equal(esp.selectBatch(many).length, 20);
  assert.equal(esp.selectBatch(many)[0].id, 0);
  const heavy = [
    { id: 'a', queued_at: 1, bytes: 1000000, body: {} },
    { id: 'b', queued_at: 2, bytes: 1000000, body: {} },
    { id: 'c', queued_at: 3, bytes: 1000000, body: {} }
  ];
  const cut = esp.selectBatch(heavy, { maxBytes: 1500000 });
  assert.deepEqual(cut.map(function (item) { return item.id; }), ['a']);
  assert.equal(esp.selectBatch(heavy, { maxCount: 1 }).length, 1);
});

test('ответ CRM: приём, токен, недоступность, отклонение', function () {
  const ok = esp.interpretCaptureResponse(200, { ok: true, accepted: 1, results: [{ kind: 'cashdesks' }] }, 1);
  assert.equal(ok.kind, 'done');
  assert.equal(ok.drop, 1);
  assert.equal(ok.summary, 'принято 1');

  const ignored = esp.interpretCaptureResponse(200, { ok: true, accepted: 0, ignored: 1 }, 1);
  assert.equal(ignored.kind, 'done');
  assert.equal(ignored.drop, 1);

  const partial = esp.interpretCaptureResponse(200, { ok: false, results: [{ ok: false }] }, 2);
  assert.equal(partial.kind, 'done');
  assert.equal(partial.drop, 1);

  assert.equal(esp.interpretCaptureResponse(401, {}, 1).kind, 'token');
  assert.equal(esp.interpretCaptureResponse(503, {}, 1).kind, 'retry');
  assert.equal(esp.interpretCaptureResponse(null, null, 1).kind, 'retry');
  assert.equal(esp.interpretCaptureResponse(413, {}, 2).kind, 'split');
  assert.equal(esp.interpretCaptureResponse(400, { message: 'bad' }, 1).kind, 'reject');
  assert.equal(esp.interpretCaptureResponse(200, { ok: false, message: 'no' }, 1).kind, 'reject');
});

test('статус CRM и новые пути без тела', function () {
  assert.equal(
    esp.statusSummary({ ok: true, last_capture_at: '2026-10-24T14:30:00+07:00', accessToken: 'secret' }),
    '2026-10-24T14:30:00+07:00'
  );
  const generic = esp.statusSummary({ ok: true, accessToken: 'secret', count: 3 });
  assert.equal(generic.includes('secret'), false);
  assert.equal(generic.includes('count: 3'), true);

  let paths = esp.rememberPath([], { method: 'GET', path: '/billing/partnerarea/reward/report/summary' });
  paths = esp.rememberPath(paths, { method: 'GET', path: '/api/v1/portal/auth/login' });
  paths = esp.rememberPath(paths, { method: 'get', path: '/billing/partnerarea/reward/report/summary' });
  assert.equal(paths.length, 1);
  assert.equal(paths[0].path, '/billing/partnerarea/reward/report/summary');
});

test('токен берётся без приставки Bearer и без пробелов внутри', function () {
  assert.equal(esp.normalizeToken('  Bearer abc.def  '), 'abc.def');
  assert.equal(esp.normalizeToken('a b'), '');
  assert.equal(esp.normalizeToken(''), '');
});

test('снимок больше 1,5 МБ не готовится к отправке', function () {
  const body = { blob: 'я'.repeat(800000) };
  assert.equal(capture(SAMPLES[2], body).reason, 'size');
});
