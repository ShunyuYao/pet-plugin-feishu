#!/usr/bin/env node
// 回归：飞书「已连接却被误判未连接」（bug表 recvrPuLTebo6N 真根因）
//
// 用户现象：明明连着飞书，看板过一会儿就显示未连接/弹「连接日历」引导；
// 一打开设置页的飞书配置，状态立刻变回已连接。
//
// 根因是两条路径判定方式不同：
//   看板   get-events → provider.getConnectionState() —— 此前只读内存，从不刷新 token
//   设置页 feishuStatus → host.feishu.status()        —— 会先 await ensureFeishuToken()
// 于是 access token 一过期，看板判未连接、设置页顺手刷新后判已连接。
// 另外 access token 过期（99991677 等）在查询路径上会被 calendar-service 的
// providerFailure 翻译成 CALENDAR_NOT_CONNECTED，同样让看板误弹重新授权引导。
'use strict';
const assert = require('assert');
const Module = require('module');
const path = require('path');

const PLUGIN = path.resolve(__dirname, '..');

let passed = 0;
function ok(name, cond, extra) {
  if (cond) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); process.exitCode = 1; }
}

function partTwo() {
  console.log('\n[2] 飞书 provider：两条路径判定必须一致 + 过期自动刷新重试\n');
  for (const k of Object.keys(require.cache)) {
    if (k.includes(PLUGIN + '')) delete require.cache[k];
  }

  const store = {};
  // US-PQ03：插件迁进 utilityProcess 后 pet.secrets 是跨进程 RPC，三个方法都返回 Promise。
  // 桩跟着改成 async，才能真实覆盖「await 漏写就读不到 token」这类跨进程回归。
  const secrets = {
    get: async (k) => (store[k] === undefined ? null : JSON.parse(store[k])),
    set: async (k, v) => { store[k] = JSON.stringify(v); },
    delete: async (k) => { delete store[k]; return true; },
  };
  // 测试内部同步塞初始 token 用（绕开 async 桩，直接写底层 store）
  const seedSecret = (k, v) => { store[k] = JSON.stringify(v); };
  const config = { feishu: { appId: 'cli_x', appSecret: 'sec_x' } };

  // 网络桩：记录调用，按脚本返回
  let calls = [];
  let refreshOk = true;
  let queryCode = 0;              // 首次 instance_view 返回的 code
  let queryCodeAfterRefresh = 0;  // 刷新后再查返回的 code
  let refreshed = false;

  // 可换的实现，便于个别用例临时接管（并发刷新 / 临时故障）
  let netFetchImpl = baseNetFetch;
  const netFetch = (url, opts) => netFetchImpl(url, opts);

  async function baseNetFetch(url, opts) {
    calls.push(url);
    if (url.includes('/authen/v2/oauth/token')) {
      refreshed = true;
      if (!refreshOk) return { status: 400, body: JSON.stringify({ code: 20037, error: 'invalid_grant' }) };
      return { status: 200, body: JSON.stringify({ access_token: 'AT-new', refresh_token: 'RT-new', expires_in: 7200, refresh_token_expires_in: 2592000 }) };
    }
    if (url.includes('/calendars/primary')) {
      return { status: 200, body: JSON.stringify({ code: 0, data: { calendars: [{ calendar: { calendar_id: 'cal_1' } }] } }) };
    }
    if (url.includes('instance_view')) {
      const code = refreshed ? queryCodeAfterRefresh : queryCode;
      if (code !== 0) return { status: 200, body: JSON.stringify({ code, msg: 'authentication token expired' }) };
      return { status: 200, body: JSON.stringify({ code: 0, data: { items: [] } }) };
    }
    return { status: 200, body: '{}' };
  }

  const ctxMod = require(path.join(PLUGIN, 'lib/ctx.js'));
  ctxMod.init({
    secrets,
    host: {
      userDataPath: '/tmp/nonexistent-feishu-test',
      getConfig: () => config, saveConfig: async () => {},
      sendToWin: () => {}, sendToSettings: () => {},
    },
    net: { fetch: netFetch },
    pet: { bubble() {}, speak() {}, meetingCard() {}, playAnim() {} },
    auth: { openAuthWindow() {} },
    scheduler: { every: () => 1, cancel: () => {} },
  });

  const auth = require(path.join(PLUGIN, 'lib/auth.js'));
  const calendar = require(path.join(PLUGIN, 'lib/calendar.js'));

  // 真跑 index.js 的 activate，拿它**实际注册**的 provider 与 host.feishu.status，
  // 不手写替身——替身只能证明我写的等价物没问题，源文件退回「只读内存不刷新」时
  // 测试照样绿，那正是本 bug 当初漏网的方式（Codex 复核点名的自证式风险）。
  let registeredProvider = null;
  let hostFeishu = null;
  const petSdk = {
    secrets,
    calendar: { registerProvider: (spec) => { registeredProvider = spec; } },
    services: { provide: () => {} },
    tools: { register: () => {}, registerSkill: () => {} },
    scheduler: { every: () => 1, cancel: () => {}, at: () => 1, daily: () => 1 },
    net: { fetch: netFetch },
    auth: { openAuthWindow: () => {} },
    pet: { bubble() {}, speak() {}, meetingCard() {}, playAnim() {} },
    host: {
      userDataPath: '/tmp/nonexistent-feishu-test',
      getConfig: () => config, saveConfig: async () => {},
      sendToWin: () => {}, sendToSettings: () => {},
    },
  };
  try {
    require(path.join(PLUGIN, 'index.js')).activate(petSdk);
    hostFeishu = petSdk.host.feishu;
  } catch (e) {
    ok('飞书 activate 成功', false, e.message);
  }
  ok('activate 注册了日历 provider', !!registeredProvider && typeof registeredProvider.getConnectionState === 'function');
  ok('activate 暴露了 host.feishu.status', !!hostFeishu && typeof hostFeishu.status === 'function');

  const getConnectionState = () => registeredProvider.getConnectionState();
  const status = () => hostFeishu.status();

  return (async () => {
    // --- 用例 A：access token 已过期，refresh_token 仍有效 ---
    // 这正是用户的处境：连着，但 token 该刷了。
    seedSecret('user-token', {
      user_access_token: 'AT-old', refresh_token: 'RT-old',
      expires_at: Date.now() - 60 * 1000,          // 已过期
      refresh_expires_at: Date.now() + 30 * 864e5,
      open_id: 'ou_1',
    });
    await auth.loadFeishuToken();
    refreshOk = true; refreshed = false; calls = [];

    const conn = await getConnectionState();
    const st = await status();
    ok('看板与设置页判定一致（都已连接）', conn.connected === st.loggedIn,
       `看板=${conn.connected} 设置页=${st.loggedIn}`);
    ok('access token 过期不算掉线，看板仍判已连接', conn.connected === true);

    // --- 用例 B：查询时飞书回 99991677，应刷新后重试成功 ---
    for (const k of Object.keys(require.cache)) {
      if (k.includes(PLUGIN + '/lib/calendar')) delete require.cache[k];
    }
    const cal2 = require(path.join(PLUGIN, 'lib/calendar.js'));
    seedSecret('user-token', {
      user_access_token: 'AT-old', refresh_token: 'RT-old',
      expires_at: Date.now() + 3600 * 1000,        // 本地看着没过期，但服务端已失效
      refresh_expires_at: Date.now() + 30 * 864e5, open_id: 'ou_1',
    });
    await auth.loadFeishuToken();
    refreshOk = true; refreshed = false; calls = [];
    queryCode = 99991677;          // 首查：服务端说 token 过期
    queryCodeAfterRefresh = 0;     // 刷新后：正常

    let events = null, err = null;
    try { events = await cal2.queryProviderEvents({ startAt: new Date().toISOString(), endAt: new Date(Date.now() + 864e5).toISOString() }); }
    catch (e) { err = e; }

    ok('token 过期时自动刷新并重试', refreshed === true);
    ok('重试后查询成功，不再向上抛「未连接」', err === null && Array.isArray(events),
       err ? err.message : `events=${JSON.stringify(events)}`);

    // --- 用例 C：refresh_token 也真失效 → 才允许报未连接 ---
    for (const k of Object.keys(require.cache)) {
      if (k.includes(PLUGIN + '/lib/calendar')) delete require.cache[k];
    }
    const cal3 = require(path.join(PLUGIN, 'lib/calendar.js'));
    seedSecret('user-token', {
      user_access_token: 'AT-old', refresh_token: 'RT-dead',
      expires_at: Date.now() + 3600 * 1000,
      refresh_expires_at: Date.now() + 30 * 864e5, open_id: 'ou_1',
    });
    await auth.loadFeishuToken();
    refreshOk = false; refreshed = false; calls = [];
    queryCode = 99991677; queryCodeAfterRefresh = 99991677;

    let err3 = null;
    try { await cal3.queryProviderEvents({ startAt: new Date().toISOString(), endAt: new Date(Date.now() + 864e5).toISOString() }); }
    catch (e) { err3 = e; }
    ok('凭据真失效时仍然报错（不吞掉真问题）', err3 !== null);
    const health3 = auth.getAuthHealth();
    ok('凭据被判失效后 hasToken=false，设置页会提示重连', health3.hasToken === false);

    // --- 用例 D：并发刷新不得互相踩掉凭据（Codex 复核指出的更严重问题）---
    // 飞书 refresh_token 一次性轮转，同值第二次使用返回 20073（在致命码表里）。
    // 没有 single-flight 时：先到的换出新凭据，后到的撞 20073 反手把新凭据删掉，
    // 用户从「token 该刷了」直接变成「真的掉线」。
    let concurrentRefreshCalls = 0;
    const usedRT = new Set();
    const savedFetch = netFetchImpl;
    netFetchImpl = async (url, opts) => {
      if (url.includes('/authen/v2/oauth/token')) {
        concurrentRefreshCalls++;
        const rt = new URLSearchParams(opts.body).get('refresh_token');
        await new Promise((r) => setTimeout(r, 20));       // 制造重叠窗口
        if (usedRT.has(rt)) {
          return { status: 400, body: JSON.stringify({ code: 20073, error: 'invalid_grant', error_description: 'refresh token has been used' }) };
        }
        usedRT.add(rt);
        return { status: 200, body: JSON.stringify({ access_token: 'AT-c', refresh_token: 'RT-c', expires_in: 7200, refresh_token_expires_in: 2592000 }) };
      }
      return savedFetch(url, opts);
    };
    seedSecret('user-token', {
      user_access_token: 'AT-old', refresh_token: 'RT-old',
      expires_at: Date.now() - 1000,                       // 已过期，必然触发刷新
      refresh_expires_at: Date.now() + 30 * 864e5, open_id: 'ou_1',
    });
    await auth.loadFeishuToken();
    const results = await Promise.all([auth.ensureFeishuToken(), auth.ensureFeishuToken(), auth.ensureFeishuToken()]);
    ok('并发刷新合并成一次请求（single-flight）', concurrentRefreshCalls === 1, `实际 ${concurrentRefreshCalls} 次`);
    ok('并发各方都拿到成功结果', results.every((r) => r === true), JSON.stringify(results));
    ok('★并发刷新后凭据仍在（不被 20073 误删）', auth.getAuthHealth().hasToken === true);
    netFetchImpl = savedFetch;

    // --- 用例 E：刷新临时失败（断网/5xx）时，错误不得被翻译成「未连接」---
    for (const k of Object.keys(require.cache)) {
      if (k.includes(PLUGIN + '/lib/calendar')) delete require.cache[k];
    }
    const cal5 = require(path.join(PLUGIN, 'lib/calendar.js'));
    const savedFetch2 = netFetchImpl;
    netFetchImpl = async (url, opts) => {
      if (url.includes('/authen/v2/oauth/token')) {
        return { status: 502, body: '<html>502 Bad Gateway</html>' };   // 临时故障，非 JSON
      }
      return savedFetch2(url, opts);
    };
    seedSecret('user-token', {
      user_access_token: 'AT-old', refresh_token: 'RT-live',
      expires_at: Date.now() + 3600 * 1000,
      refresh_expires_at: Date.now() + 30 * 864e5, open_id: 'ou_1',
    });
    await auth.loadFeishuToken();
    refreshed = false; queryCode = 99991677; queryCodeAfterRefresh = 99991677;
    let err5 = null;
    try { await cal5.queryProviderEvents({ startAt: new Date().toISOString(), endAt: new Date(Date.now() + 864e5).toISOString() }); }
    catch (e) { err5 = e; }
    ok('刷新临时失败时凭据保留（不误判掉线）', auth.getAuthHealth().hasToken === true);
    // Host calendar-service translation assertions remain in the host regression gate.
    ok('临时错误带有上下文', !!err5 && !!err5.message);
    netFetchImpl = savedFetch2;

    // --- 用例 F：single-flight 的边界 ---
    // F1 刷新抛异常后 in-flight 必须清理，否则后续刷新永远拿到旧的失败 Promise。
    const savedFetch3 = netFetchImpl;
    let throwOnce = true;
    netFetchImpl = async (url, opts) => {
      if (url.includes('/authen/v2/oauth/token')) {
        if (throwOnce) { throwOnce = false; throw new Error('boom'); }
        return { status: 200, body: JSON.stringify({ access_token: 'AT-f', refresh_token: 'RT-f', expires_in: 7200, refresh_token_expires_in: 2592000 }) };
      }
      return savedFetch3(url, opts);
    };
    seedSecret('user-token', {
      user_access_token: 'AT-old', refresh_token: 'RT-f0',
      expires_at: Date.now() - 1000, refresh_expires_at: Date.now() + 30 * 864e5, open_id: 'ou_1',
    });
    await auth.loadFeishuToken();
    const f1 = await auth.refreshFeishuToken();
    const f2 = await auth.refreshFeishuToken();
    ok('刷新异常返回 false 不抛出', f1 === false);
    ok('异常后 in-flight 已清理，下次能正常刷新', f2 === true);

    // F2 刷新在途时 logout：结果必须丢弃，不能把已登出的账号复活（并且不能崩）。
    seedSecret('user-token', {
      user_access_token: 'AT-old', refresh_token: 'RT-g0',
      expires_at: Date.now() - 1000, refresh_expires_at: Date.now() + 30 * 864e5, open_id: 'ou_1',
    });
    await auth.loadFeishuToken();
    let crashed = null;
    const pending = auth.refreshFeishuToken().catch((e) => { crashed = e; return false; });
    await auth.logout();                 // 刷新在途时用户点退出（US-PQ03 后写加密仓是异步的）
    await pending;
    ok('登出期间刷新不崩溃', crashed === null, crashed && crashed.message);
    // secrets.get 现在是 async，必须 await——直接判 Promise 恒为真，断言会永远「通过」
    ok('★登出后不被在途刷新「复活」凭据',
       !auth.getToken() && !(await secrets.get('user-token')));
    netFetchImpl = savedFetch3;
  })();
}

(async () => {
  console.log('=== 飞书连接状态一致性回归（bug表 recvrPuLTebo6N 真根因）===');

  await partTwo();
  console.log(`\n${process.exitCode ? '❌ 有断言未通过' : `✅ 全部通过（${passed} 条断言）`}\n`);
})();
