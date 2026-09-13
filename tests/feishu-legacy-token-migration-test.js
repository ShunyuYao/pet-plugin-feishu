'use strict';
// US-PQ04：飞书插件不再 require('fs')，旧版明文 token 改经特权 SDK 迁移。
// 运行：node tests/feishu-legacy-token-migration-test.js
//
// 锁两层：
//   A 插件侧（auth.js）——迁移语义。核心风险是「改存储位置不做兼容读取 → 用户升级即被登出」，
//     所以必须验：旧文件能读回、迁完删旧文件、加密仓不可用时**保留**旧文件、重复启动幂等。
//   B 宿主侧（runtime.js sdkCallPrivileged）——readLegacyFile/removeLegacyFile 只认 userData
//     根目录裸文件名，且只给内置插件。这条通道要是能吃 `../` 就成了任意文件读取原语。
//
// 全程不打网络、不起 Electron、不碰真实飞书账号。

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
const out = console.info.bind(console);
const ok = (c, l, x) => { c ? (pass++, out('  ✓', l)) : (fail++, out('  ✗', l, x === undefined ? '' : JSON.stringify(x))); };

// ---------- A. 插件侧迁移语义 ----------
const ctxPath = path.resolve(__dirname, '../lib/ctx.js');

// 假 userData：遗留文件真落盘，让「读回/删除/保留」都是可观测的文件系统事实，不是桩的自证。
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-pq04-'));
const legacyFile = path.join(userData, 'feishu-token.json');

const store = { _v: null, get() { return this._v; }, set(k, v) { this._v = v; }, delete() { this._v = null; } };
const stub = {
  _secretsBroken: false,     // 模拟 safeStorage 不可用 / 加密仓损坏
  _readCalls: 0,
  _removeCalls: 0,
  getConfig: () => ({ feishu: { appId: 'cli_x', appSecret: 's' } }),
  saveConfig: async () => {},
  getSecret: async () => store.get(),
  setSecret: async (k, v) => { if (stub._secretsBroken) throw new Error('safeStorage 不可用'); store.set(k, v); },
  delSecret: async () => { if (stub._secretsBroken) throw new Error('safeStorage 不可用'); store.delete(); },
  readLegacyFile: async (name) => {
    stub._readCalls++;
    const f = path.join(userData, name);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  },
  removeLegacyFile: async (name) => {
    stub._removeCalls++;
    const f = path.join(userData, name);
    try { if (fs.existsSync(f)) fs.unlinkSync(f); return true; } catch { return false; }
  },
  pet: { host: { userDataPath: userData, sendToWin: () => {}, sendToSettings: () => {} } },
  netFetch: async () => ({ status: 200, body: '{}' })
};
require.cache[ctxPath] = { id: ctxPath, filename: ctxPath, loaded: true, exports: stub };

const auth = require('../lib/auth.js');
const QUIET = process.env.FEISHU_TEST_VERBOSE !== '1';
if (QUIET) console.log = () => {};

const LEGACY = { user_access_token: 'legacy-at', refresh_token: 'legacy-rt', expires_at: Date.now() + 3600e3, open_id: 'ou_legacy' };
const writeLegacy = (obj) => fs.writeFileSync(legacyFile, typeof obj === 'string' ? obj : JSON.stringify(obj));
const reset = () => { store.delete(); stub._secretsBroken = false; try { fs.unlinkSync(legacyFile); } catch {} };

(async () => {
  out('A1 旧格式凭据能被读回并迁入加密仓');
  reset();
  writeLegacy(LEGACY);
  await auth.loadFeishuToken();
  ok(!!auth.getToken() && auth.getToken().user_access_token === 'legacy-at', '旧文件里的 token 已读回内存');
  ok(store.get() && store.get().user_access_token === 'legacy-at', '已写进加密仓（secrets）');
  ok(!fs.existsSync(legacyFile), '迁移成功后旧明文文件已删除');

  out('A2 重复启动幂等：不重迁、不覆盖已更新的凭据');
  // 模拟迁移后 token 已被刷新过（加密仓里是新值），再启动一次不能被旧值盖回去。
  store.set('user-token', { user_access_token: 'refreshed-at', refresh_token: 'rt-2', expires_at: Date.now() + 3600e3 });
  const readsBefore = stub._readCalls;
  await auth.loadFeishuToken();
  ok(auth.getToken().user_access_token === 'refreshed-at', '第二次启动读到的是加密仓里的新值');
  ok(stub._readCalls === readsBefore, '加密仓有值时根本不去碰遗留文件');

  // 就算旧文件被用户手工放回来，只要加密仓有值也不会触发迁移。
  writeLegacy(LEGACY);
  await auth.loadFeishuToken();
  ok(auth.getToken().user_access_token === 'refreshed-at', '旧文件重现也不会覆盖加密仓里的新凭据');
  ok(fs.existsSync(legacyFile), '未触发迁移，故旧文件原样留着');

  out('A3 加密仓不可用时保留旧文件（绝不能把用户唯一凭据删掉）');
  reset();
  writeLegacy(LEGACY);
  stub._secretsBroken = true;
  await auth.loadFeishuToken();
  ok(fs.existsSync(legacyFile), '写加密仓失败 → 旧明文文件必须保留');
  ok(auth.getToken() === null, '写不进加密仓时不谎报已登录');
  // 加密仓恢复后，下次启动仍能迁移成功——凭据没丢。
  stub._secretsBroken = false;
  await auth.loadFeishuToken();
  ok(!!auth.getToken() && auth.getToken().user_access_token === 'legacy-at', '加密仓恢复后仍能读回旧凭据');
  ok(!fs.existsSync(legacyFile), '此时才删除旧文件');

  out('A4 旧文件内容损坏：不迁移、不清空、保留原文件');
  reset();
  writeLegacy('{ 不是 JSON');
  await auth.loadFeishuToken();
  ok(auth.getToken() === null, '损坏内容不会变成半个登录态');
  ok(store.get() === null, '损坏内容不会被写进加密仓');
  ok(fs.existsSync(legacyFile), '损坏的旧文件保留供排查');

  out('A5 无旧文件：静默无事发生');
  reset();
  const removesBefore = stub._removeCalls;
  await auth.loadFeishuToken();
  ok(auth.getToken() === null, '没有旧数据时不报错、不伪造凭据');
  ok(stub._removeCalls === removesBefore, '没有旧文件时不去删任何东西');

  out('A6 插件源码里不再有绕过 SDK 的 node 内置模块调用');
  const feishuDir = path.resolve(__dirname, '..');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const jsFiles = [path.join(feishuDir, 'index.js'), ...walk(path.join(feishuDir, 'lib')).filter(f => f.endsWith('.js'))];
  const offenders = [];
  for (const f of jsFiles) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (line.trim().startsWith('//')) return;                       // 注释里的说明不算
      if (/require\(\s*['"](fs|path|os|net|child_process|http|https|dgram|worker_threads)['"]\s*\)/.test(line)) {
        offenders.push(`${path.relative(feishuDir, f)}:${i + 1}`);
      }
    });
  }
  ok(offenders.length === 0, '飞书插件无 fs/path/net/child_process 等直连调用', offenders);

  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
  out(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
