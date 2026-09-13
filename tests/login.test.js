'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ctx = require('../lib/ctx');
const auth = require('../lib/auth');
function setup({ failWindow = false, cancel = false, autoCreate = false } = {}) {
  const config = { feishu: autoCreate ? {} : { appId: 'synthetic-app', appSecret: 'synthetic-secret' } };
  let token = null, closed = false, onClosed, saves = 0;
  const requests = [], progress = [];
  const pet = {
    host: { getConfig: () => config, saveConfig: async () => { saves++; }, sendToWin() {}, sendToSettings(channel, value) { progress.push([channel, value.text]); } },
    secrets: { get: async () => token, set: async (_, value) => { token = value; return true; }, delete: async () => { token = null; return true; } },
    auth: { openAuthWindow: () => ({
      async loadURL() { if (failWindow) throw new Error('synthetic window failed'); if (cancel) { closed = true; onClosed(); } },
      isDestroyed: () => closed, onClosed(fn) { onClosed = fn; }, close() { closed = true; }, focus() {}
    }) },
    scheduler: { every: async () => 'test-schedule', cancel: async () => true },
    pet: { bubble() {}, speak() {}, playAnim() {}, meetingCard() {} },
    net: { fetch: async (url, options) => {
      requests.push(url);
      const form = new URLSearchParams(options?.body);
      let body;
      if (url.endsWith('/app/registration')) body = form.get('action') === 'begin'
        ? { device_code: 'synthetic-reg', verification_uri_complete: 'https://open.feishu.cn/page/cli', interval: 1, expires_in: 5 }
        : { client_id: 'synthetic-created', client_secret: 'synthetic-secret', user_info: { open_id: 'synthetic-user' } };
      else if (url.endsWith('/device_authorization')) body = { device_code: 'synthetic-code', verification_uri: 'https://accounts.feishu.cn/test', interval: 1, expires_in: 5 };
      else if (url.endsWith('/oauth/token')) body = { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 7200 };
      else body = { code: 0, data: { open_id: 'synthetic-user', items: [] } };
      return { status: 200, body: JSON.stringify(body) };
    } }
  };
  ctx.init(pet);
  return { config, requests, progress, token: () => token, closed: () => closed, saves: () => saves };
}
test('OAuth window failures surface and never persist a token', async () => {
  const state = setup({ failWindow: true }); await auth.logout();
  const result = await auth.feishuLogin();
  assert.deepEqual(result, { ok: false, error: 'synthetic window failed' });
  assert.equal(state.token(), null); assert.equal(state.closed(), true);
});
test('Closing authorization cancels polling without credentials', async () => {
  const state = setup({ cancel: true }); await auth.logout();
  const result = await auth.feishuLogin();
  assert.equal(result.ok, false); assert.match(result.error, /关闭/);
  assert.equal(state.token(), null); assert.equal(state.requests.length, 1);
});
test('Device authorization persists token through secrets and closes the window', async () => {
  const state = setup(); await auth.logout();
  const result = await auth.feishuLogin();
  assert.equal(result.ok, true); assert.equal(state.token().refresh_token, 'synthetic-refresh');
  assert.equal(state.closed(), true); assert.ok(state.progress.length);
  await auth.logout(); assert.equal(state.token(), null);
});
test('Auto-created application persists settings before device authorization', async () => {
  const state = setup({ autoCreate: true }); await auth.logout();
  const result = await auth.feishuLogin();
  assert.equal(result.ok, true); assert.equal(state.config.feishu.appId, 'synthetic-created');
  assert.ok(state.saves() > 0); assert.equal(state.token().open_id, 'synthetic-user');
  await auth.logout();
});
