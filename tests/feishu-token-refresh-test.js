'use strict';
// 飞书 token 刷新韧性回归：临时故障绝不删凭据，只有飞书明确判定 refresh_token 失效才要求重新授权。
// 背景：原实现里 refreshFeishuToken 只要拿不到 access_token 就 feishuToken=null，
// 而 feishuFormPost 把网络异常/超时/HTML 错误页统统降级成 {}，于是断网或 5xx 一次就掉线。
// 日历每 2 分钟轮询一次 → 一天几百次曝光，用户表现为"每天都要重新点一次登录"。
const path = require('path');
const ctxPath = path.resolve(__dirname, '../lib/ctx.js');

// 单例 secrets 桩。US-PQ03 起插件跑在子进程，ctx 的 secrets 三个方法都是跨进程 RPC，
// 故桩也改成 async 的 getSecret/setSecret/delSecret（与 ctx.js 新形状一致）。
const store = { _v: null, get() { return this._v; }, set(k, v) { this._v = v; }, delete() { this._v = null; } };
const stub = {
  _mode: 'ok',
  getConfig: () => ({ feishu: { appId: 'cli_x', appSecret: 's' } }),
  saveConfig: async () => {},
  getSecret: async () => store.get(),
  setSecret: async (k, v) => store.set(k, v),
  delSecret: async () => store.delete(),
  pet: { host: { userDataPath: null, sendToWin: () => {}, sendToSettings: () => {} } },
  netFetch: async () => {
    if (stub._mode === 'throw') throw new Error('net::ERR_INTERNET_DISCONNECTED');
    if (stub._mode === 'html') return { status: 502, body: '<html>Bad Gateway</html>' };
    if (stub._mode === 'rate') return { status: 200, body: JSON.stringify({ code: 99991400, error: 'rate_limited', error_description: 'too many' }) };
    if (stub._mode === 'fatal') return { status: 400, body: JSON.stringify({ code: 20037, error: 'invalid_grant', error_description: 'refresh token expired' }) };
    return { status: 200, body: JSON.stringify({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 7200, refresh_token_expires_in: 604800 }) };
  }
};
require.cache[ctxPath] = { id: ctxPath, filename: ctxPath, loaded: true, exports: stub };

const auth = require('../lib/auth.js');
const QUIET = process.env.FEISHU_TEST_VERBOSE !== '1';
if (QUIET) console.log = () => {};           // 插件内部日志静音，只留断言输出
const out = console.info.bind(console);

let pass = 0, fail = 0;
const ok = (c, l, x) => { c ? (pass++, out('  ✓', l)) : (fail++, out('  ✗', l, x === undefined ? '' : JSON.stringify(x))); };
const setTok = async (t) => { store.set('user-token', t); await auth.loadFeishuToken(); };
const EXPIRED = () => Date.now() - 1000;

(async () => {
  out('临时故障不得清除凭据');
  for (const [mode, label] of [['throw', '断网/超时'], ['html', '502 HTML 错误页'], ['rate', '限流/未知业务码']]) {
    await setTok({ user_access_token: 'old', refresh_token: 'rt-1', expires_at: EXPIRED() });
    stub._mode = mode;
    const r = await auth.refreshFeishuToken();
    ok(r === false, `${label}：刷新返回 false`);
    ok(!!auth.getToken(), `${label}：内存凭据保留`);
    ok(store.get() !== null, `${label}：加密仓凭据保留`);
    ok(auth.getAuthHealth().code === 'CONNECTED', `${label}：状态不谎报 AUTH_REQUIRED`);
  }

  out('飞书明确判定失效才清凭据');
  await setTok({ user_access_token: 'old', refresh_token: 'rt-1', expires_at: EXPIRED() });
  stub._mode = 'fatal';
  await auth.refreshFeishuToken();
  ok(auth.getToken() === null, '20037/invalid_grant：凭据清空');
  ok(auth.getAuthHealth().code === 'AUTH_REQUIRED', '20037/invalid_grant：状态 AUTH_REQUIRED');

  out('正常刷新：轮转 + 期限跟踪');
  await setTok({ user_access_token: 'old', refresh_token: 'rt-1', expires_at: EXPIRED() });
  stub._mode = 'ok';
  await auth.refreshFeishuToken();
  const t = auth.getToken();
  ok(t.user_access_token === 'new-at', 'access_token 已更新');
  ok(t.refresh_token === 'new-rt', '轮转后的新 refresh_token 已保存（旧值飞书侧立即作废）');
  ok(typeof t.refresh_expires_at === 'number' && t.refresh_expires_at > Date.now(), 'refresh_token_expires_in 已记录');
  ok(auth.getAuthHealth().refreshFailureStreak === 0, '成功后失败计数归零');

  out('刷新失败不影响未过期的 access token');
  await setTok({ user_access_token: 'still-valid', refresh_token: 'rt-1', expires_at: Date.now() + 3600e3 });
  stub._mode = 'throw';
  ok((await auth.ensureFeishuToken()) === true, 'access token 未过期 → 仍可用');

  out('提前量刷新');
  await setTok({ user_access_token: 'old', refresh_token: 'rt-1', expires_at: Date.now() + 5 * 60 * 1000 });
  stub._mode = 'ok';
  await auth.ensureFeishuToken();
  ok(auth.getToken().user_access_token === 'new-at', '到期前 10 分钟主动刷新');

  out('长时间断网后自愈（模拟一天几百次轮询）');
  await setTok({ user_access_token: 'old', refresh_token: 'rt-1', expires_at: EXPIRED() });
  stub._mode = 'throw';
  for (let i = 0; i < 300; i++) await auth.refreshFeishuToken();
  ok(!!auth.getToken(), '300 次连续失败后凭据仍在');
  ok(auth.getAuthHealth().refreshFailureStreak === 300, '失败计数如实累计');
  stub._mode = 'ok';
  await auth.refreshFeishuToken();
  ok(auth.getToken().user_access_token === 'new-at', '网络恢复后自动痊愈，无需人工重新登录');

  out(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
