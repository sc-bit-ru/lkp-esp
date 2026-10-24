const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function read(name) {
  return fs.readFileSync(path.join(root, name), 'utf8');
}

test('в кабинет ЕСП нет своих запросов', function () {
  const hook = read('hook.js');
  const bridge = read('bridge.js');
  const background = read('background.js');
  const popup = read('popup.js');
  [hook, bridge, background, popup].forEach(function (source) {
    assert.equal(source.includes('lkp.ao-esp.ru'), false);
    assert.equal(source.includes('document.cookie'), false);
    assert.equal(source.includes("credentials: 'include'"), false);
    assert.equal(source.includes('new XMLHttpRequest'), false);
    assert.equal(source.includes('new WebSocket'), false);
    assert.equal(source.includes('chrome.cookies'), false);
  });
  assert.equal(hook.includes('https://'), false);
  assert.equal(hook.includes('resp.clone'), true);
  assert.equal((background.match(/fetch\s*\(/g) || []).length, 1);
  assert.equal(background.includes('fetch(url'), true);
  assert.equal(background.includes('crmEndpoint'), true);
  assert.equal(popup.includes('fetch('), false);
  assert.equal(bridge.includes('fetch('), false);
  assert.equal(read('options.js').includes('permissions.request'), true);
});

test('хосты не зашиты в код перехвата и манифест', function () {
  const orgMark = ['bit', '22'].join('');
  ['lib.js', 'hook.js', 'bridge.js', 'background.js', 'popup.js', 'options.js', 'options.html', 'manifest.json'].forEach(function (name) {
    const text = read(name);
    assert.equal(text.toLowerCase().includes(orgMark), false, name);
    if (name !== 'options.html') assert.equal(text.includes('lkp.ao-esp.ru'), false, name);
  });
  assert.equal(read('lib.js').includes('/api/v2/ingest/esp-lkp/capture'), true);
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*']);
  assert.equal(manifest.options_ui.page, 'options.html');
});
