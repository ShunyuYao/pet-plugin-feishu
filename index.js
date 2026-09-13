// 官方市场飞书插件：用户安装并授权后在隔离的工具进程运行。
// 通过 host:feishu 的受限兼容接口连接宿主设置；token 进 pet.secrets、
// 联网走 pet.net、授权窗走 pet.auth、调度走 pet.scheduler、config 经 pet.host。
// 通过 pet.services.provide('feishu', ...) 对外暴露编程接口，供别人写"飞书打卡插件"消费。
const ctx = require('./lib/ctx');
const auth = require('./lib/auth');
const calendar = require('./lib/calendar');
const contacts = require('./lib/contacts');
const im = require('./lib/im');
const report = require('./lib/report');

// US-PQ03：本插件已从主进程内直调改为 utilityProcess 子进程（与第三方插件同一条路径）。
// activate 因此变成 async——token 读取要经跨进程 secrets RPC。tool-host 会 await 这个 Promise
// 并在 reject 时上报 activate-error，故启动失败不会静默。
module.exports.activate = async (pet) => {
  ctx.init(pet);

  // 4 个 AI 工具（顺序 = 发给模型的 tools 顺序）
  calendar.registerTools(pet);
  im.registerTools(pet);
  report.registerTools(pet);

  // 通用日历 Provider：宿主/Dashboard 只认 Calendar 契约，不认飞书。
  // 飞书 OAuth、Token、主日历和 OpenAPI 字段转换仍完全留在本插件内。
  pet.calendar.registerProvider({
    id: 'feishu',
    name: '飞书日历',
    capabilities: { query: true, create: true, attendees: true, reminders: true },
    // 凭据还在但一时刷不动（断网/5xx）时报 CONNECTED，不谎称需要重新授权——
    // 只有 refresh_token 被飞书判定失效、凭据已清空，才是真的 AUTH_REQUIRED
    //
    // 先 ensureFeishuToken 再取健康值，和下面 host.feishu.status 走同一条路：
    // 此前这里只读内存、从不刷新，而设置页的 status() 会 await ensureFeishuToken()，
    // 于是同一时刻看板判「未连接」、设置页判「已连接」——用户一打开设置页状态就
    // 自己好了（设置页那条路顺手把 token 刷了）。两条路径必须同源，否则永远不一致。
    getConnectionState: async () => {
      try { await auth.ensureFeishuToken(); } catch { /* 临时故障不改结论，下面按凭据是否还在判定 */ }
      const health = auth.getAuthHealth();
      return {
        connected: health.hasToken && !!ctx.getConfig().feishu.appId,
        code: health.hasToken ? 'CONNECTED' : 'AUTH_REQUIRED',
        refreshExpiresAt: health.refreshExpiresAt || null,
        degraded: health.hasToken && health.refreshFailureStreak > 0,
        lastError: health.lastError || null
      };
    },
    queryEvents: (range) => calendar.queryProviderEvents(range),
    createEvent: (input) => calendar.createProviderEvent(input)
  });

  // 对外服务：别的插件 pet.services.get('feishu') 拿到这套受控代理（授权后）
  pet.services.provide('feishu', {
    sendMessage: (to, text) => im.feishuSendMessage({ to, text }),
    resolveContact: (q) => contacts.resolveAttendee(q),
    queryEvents: (range) => calendar.feishuQueryEvents(range),
    createEvent: (ev) => calendar.feishuCreateEvent(ev),
    isLoggedIn: () => !!auth.getToken(),
    getOpenId: () => { const t = auth.getToken(); return t && t.open_id; }
  });

  // host:feishu 显式授权的兼容接口：宿主 feishu-* IPC 转调这些方法
  pet.host.feishu = {
    login: (creds) => auth.feishuLogin(creds),
    // 先尽力刷新，但结论以「凭据是否还在」为准：临时刷新失败不等于掉线，
    // 否则一次网络抖动就会让设置页/前端弹出"需要重新登录"
    status: async () => {
      try { await auth.ensureFeishuToken(); } catch {}
      const health = auth.getAuthHealth();
      return { loggedIn: health.hasToken, degraded: !!health.degraded, lastError: health.lastError || null };
    },
    logout: async () => { await auth.logout(); await calendar.onLogout(); return { loggedIn: false }; },
    hasToken: () => !!auth.getToken(),
    queryEvents: (range) => calendar.feishuQueryEvents(range)
  };

  // 启动序列：读 token → 有则起日历轮询；晨报/日报调度常驻（tick 内自查 token）
  await auth.loadFeishuToken();
  const t = auth.getToken();
  if (t) {
    if (!t.open_id) auth.fetchMyOpenId().catch(() => {});
    await calendar.startFeishuPolling();
  }
  await report.startReportScheduler();
  console.log('[feishu] 市场插件已激活');
};
