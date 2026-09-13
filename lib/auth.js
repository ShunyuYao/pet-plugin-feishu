// 飞书底座：设备码 OAuth（含自动建应用）、user/tenant token 存取与刷新、HTTP 工具、scope 拼装。
// 阶段二½：飞书成为内置特权插件。相较原内核实现的变化——
// - token 从明文 feishu-token.json 迁到 pet.secrets（safeStorage 加密仓，按插件 id 隔离）
// - 所有联网走 pet.net.fetch（manifest 域名白名单授权），不再裸 fetch
// - 授权窗走 pet.auth.openAuthWindow（受控句柄，拿不到窗口本体）
// - 登录进度/状态直接经 pet.host 推给设置页/宠物，不再持有窗口引用
const ctx = require('./ctx');

const FEISHU_BASE = 'https://open.feishu.cn';
const FEISHU_ACCOUNTS = 'https://accounts.feishu.cn';

const FEISHU_SCOPE_BLOCKS = {
  calendar: ['calendar:calendar', 'calendar:calendar:readonly', 'calendar:calendar.event:create', 'calendar:timeoff'],
  message: ['im:message:send_as_bot', 'im:chat:readonly'],
  docs: [
    'docx:document', 'docx:document:create', 'docx:document:readonly',
    'docs:document.content:read', 'docs:document.media:download', 'docs:document.media:upload',
    'drive:drive.metadata:readonly', 'drive:file:download', 'drive:file:upload',
    'space:document:delete', 'space:folder:create',
    'sheets:spreadsheet', 'sheets:spreadsheet:create', 'sheets:spreadsheet:read',
    'bitable:app', 'base:app:read', 'base:app:create', 'base:table:read', 'base:record:read', 'base:record:create', 'base:record:update',
    'wiki:wiki', 'wiki:wiki:readonly', 'wiki:space:read', 'wiki:node:read'
  ],
  task: ['task:task', 'task:task:read', 'task:task:write', 'task:tasklist:read', 'task:tasklist:write'],
  ai: ['optical_char_recognition:image', 'speech_to_text:speech',
       'minutes:minutes.search:read', 'minutes:minutes.artifacts:read', 'minutes:minutes.upload:write']
};
const FEISHU_BASE_SCOPES = ['offline_access', 'auth:user.id:read'];
function buildFeishuScope() {
  const config = ctx.getConfig();
  const domains = Array.isArray(config.feishu.scopeDomains) && config.feishu.scopeDomains.length
    ? config.feishu.scopeDomains : ['calendar', 'message'];
  const set = new Set(FEISHU_BASE_SCOPES);
  for (const d of domains) (FEISHU_SCOPE_BLOCKS[d] || []).forEach((s) => set.add(s));
  String(config.feishu.extraScope || '').trim().split(/\s+/).filter(Boolean).forEach((s) => set.add(s));
  return [...set].join(' ');
}

let feishuToken = null;       // { user_access_token, refresh_token, expires_at, open_id }

// US-PQ03 起本插件在子进程内运行，pet.secrets 三个方法都是跨进程 RPC → 全部改 async。
// 调用方一律 await；getToken() 仍同步读内存缓存，故绝大多数消费点无需改。
async function loadFeishuToken() {
  try {
    feishuToken = (await ctx.getSecret('user-token')) || null;
    if (!feishuToken) await migrateLegacyToken();   // 老版本明文 feishu-token.json → 迁进加密仓
  } catch { feishuToken = null; }
}
// 一次性迁移：内核时代 token 明文存 userData/feishu-token.json，搬进 pet.secrets 后删明文。
//
// US-PQ04：这里原本 require('fs') + require('path') 直接读 userData，是飞书插件最后一处
// 绕过 SDK 的文件访问。改走 pet.host.readLegacyFile/removeLegacyFile（受限兼容面，仅显式授权的飞书插件，
// 主进程侧限定为 userData 根目录裸文件名）。数据语义不变：
// - 只在加密仓里读不到 user-token 时才尝试（loadFeishuToken 已保证），故是幂等的：
//   迁移成功后旧文件被删、新位置有值，下次启动第一步就命中新位置，不会重复迁移或回写覆盖；
// - 加密仓不可用（basic_text/损坏）时**保留旧文件**并清空内存态——绝不能删掉唯一可用凭据，
//   否则用户升级即被登出（criteria §7 头号失败项）；
// - 旧文件里内容损坏（非 JSON）也按「无旧数据」处理，同样保留原文件供人工排查。
const LEGACY_TOKEN_FILE = 'feishu-token.json';
async function migrateLegacyToken() {
  try {
    const raw = await ctx.readLegacyFile(LEGACY_TOKEN_FILE);
    if (!raw) return;                       // 没有旧文件，或读不到 → 无事发生
    let legacy = null;
    try { legacy = JSON.parse(raw); } catch { legacy = null; }
    if (!legacy || typeof legacy !== 'object' || !legacy.user_access_token) {
      console.log('[feishu] 旧 token 文件内容无效，保留原文件不迁移');
      return;
    }
    feishuToken = legacy;
    if (!(await saveFeishuToken())) {
      feishuToken = null;
      return; // 加密仓不可用时保留旧文件，不能删掉唯一可用凭据
    }
    // 删不掉也不回滚：凭据已在加密仓里，下次启动第一步就命中新位置，不会再读旧文件。
    if (await ctx.removeLegacyFile(LEGACY_TOKEN_FILE)) {
      console.log('[feishu] 已把明文 token 迁入加密仓并删除旧文件');
    } else {
      console.log('[feishu] 已把明文 token 迁入加密仓，但旧文件删除失败（不影响使用）');
    }
  } catch (e) { /* 无旧文件或迁移失败都不影响正常登录 */ }
}
async function saveFeishuToken() {
  try {
    if (feishuToken) await ctx.setSecret('user-token', feishuToken);
    else await ctx.delSecret('user-token');
    return true;
  } catch (e) {
    console.log('[feishu] token 保存失败', e.message);
    return false;
  }
}
function getToken() { return feishuToken; }
async function logout() { feishuToken = null; await saveFeishuToken(); }

// 经 pet.net.fetch（白名单）请求 open.feishu.cn 的 JSON 接口
async function feishuFetch(urlPath, opts = {}) {
  const res = await ctx.netFetch(FEISHU_BASE + urlPath, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(opts.headers || {}) },
    body: opts.body
  });
  try { return JSON.parse(res.body); } catch { return {}; }
}

// OAuth 表单请求（注册/设备授权/token 接口都是 x-www-form-urlencoded，不是 JSON）
// 注意：解析失败不能再静默返回 {}——调用方无法区分「飞书说凭据无效」和「网络抖动/5xx/HTML 错误页」，
// 会把临时故障误判成凭据失效。这里带上 __transport 标记，让 refresh 侧能分流。
async function feishuFormPost(url, form, headers = {}) {
  const res = await ctx.netFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(form).toString()
  });
  try { return JSON.parse(res.body); }
  catch {
    // 非 JSON（网关 HTML、空响应等）一律按传输故障处理，绝不当成凭据失效
    return { __transport: { status: res && res.status, reason: 'non_json_response' } };
  }
}

// 通用设备码轮询：pick 从响应里挑出结果（返回 null 继续等），isCancelled 为 true 立即中止
async function feishuDevicePoll(url, form, interval, expiresIn, pick, isCancelled, headers) {
  const deadline = Date.now() + (expiresIn || 300) * 1000;
  let wait = Math.max(interval || 5, 1);
  while (Date.now() < deadline) {
    if (isCancelled()) throw new Error('窗口已关闭，登录未完成');
    await new Promise((r) => setTimeout(r, wait * 1000));
    if (isCancelled()) throw new Error('窗口已关闭，登录未完成');
    let data;
    try { data = await feishuFormPost(url, form, headers); }
    catch { wait = Math.min(wait + 1, 60); continue; }
    const hit = pick(data);
    if (hit) return hit;
    const err = data.error || '';
    if (err === '' || err === 'authorization_pending') continue;
    if (err === 'slow_down') { wait = Math.min(wait + 5, 60); continue; }
    if (err === 'access_denied') throw new Error('你在授权页上拒绝了');
    if (err === 'expired_token' || err === 'invalid_grant') throw new Error('授权码已过期，请重新点登录');
    throw new Error(data.error_description || err);
  }
  throw new Error('授权超时，请重新点登录');
}

// tenant_access_token：通讯录等应用身份接口用（与 user token 不同）
let tenantToken = null; // { token, expires_at }
async function getTenantAccessToken() {
  if (tenantToken && Date.now() < tenantToken.expires_at) return tenantToken.token;
  const { appId, appSecret } = ctx.getConfig().feishu;
  if (!appId || !appSecret) return null;
  const data = await feishuFetch('/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });
  if (!data.tenant_access_token) return null;
  tenantToken = { token: data.tenant_access_token, expires_at: Date.now() + ((data.expire || 7200) - 300) * 1000 };
  return tenantToken.token;
}

// 拿当前登录用户的 open_id（发消息目标）
async function fetchMyOpenId() {
  if (!feishuToken) return null;
  const data = await feishuFetch('/open-apis/authen/v1/user_info', {
    headers: { Authorization: `Bearer ${feishuToken.user_access_token}` }
  });
  if (data.code === 0 && data.data && data.data.open_id) {
    feishuToken.open_id = data.data.open_id;
    await saveFeishuToken();
    return feishuToken.open_id;
  }
  return null;
}

// 飞书 authen/v2 刷新失败里，只有这些才是「refresh_token 本身真的不能用了」，必须重新授权。
// 20024 与 client_id 不匹配 / 20026 值非法 / 20037 已过期 / 20064 已被吊销 / 20073 已被用过 / 20074 应用无权刷新
// 见 https://open.feishu.cn/document/authentication-management/access-token/refresh-user-access-token
const FATAL_REFRESH_CODES = new Set([20024, 20026, 20037, 20064, 20073, 20074]);
const FATAL_REFRESH_ERRORS = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);

// 只有能明确证明凭据失效时才返回 true；网络异常、5xx、限流、非 JSON 一律 false（保留凭据重试）
function isFatalRefreshFailure(data) {
  if (!data || data.__transport) return false;              // 传输层故障，与凭据无关
  if (typeof data.code === 'number' && FATAL_REFRESH_CODES.has(data.code)) return true;
  if (data.error && FATAL_REFRESH_ERRORS.has(String(data.error))) return true;
  return false;
}

function describeRefreshFailure(data) {
  if (data && data.__transport) return `传输故障(${data.__transport.reason}, status=${data.__transport.status})`;
  return (data && (data.error_description || data.error || data.msg)) || '未知错误';
}

// 连续临时失败计数：只用于日志/状态展示，不触发删号
let refreshFailureStreak = 0;
let lastRefreshError = null;

// 刷新 single-flight：飞书的 refresh_token 是一次性轮转的，同一个值第二次使用会返回
// 20073（已被用过）——而 20073 在 FATAL_REFRESH_CODES 里，会清空凭据。
// 所以两路并发刷新的后果是：先到的成功换出新凭据，后到的拿旧 refresh_token 撞 20073，
// 反手把刚写进去的新凭据删掉，用户直接被登出。看板轮询、设置页状态、日历查询都会
// 触发刷新，重叠是常态，必须收敛成一次请求、多方共享同一个 Promise。
let refreshInFlight = null;
function refreshFeishuToken() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefreshFeishuToken().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function doRefreshFeishuToken() {
  const { appId, appSecret } = ctx.getConfig().feishu;
  if (!appId || !appSecret || !feishuToken || !feishuToken.refresh_token) return false;
  let data;
  try {
    data = await feishuFormPost(`${FEISHU_BASE}/open-apis/authen/v2/oauth/token`, {
      grant_type: 'refresh_token',
      refresh_token: feishuToken.refresh_token,
      client_id: appId,
      client_secret: appSecret
    });
  } catch (e) {
    // 断网、超时、DNS 失败等：pet.net.fetch 直接 throw。绝不能因此丢弃凭据。
    refreshFailureStreak++;
    lastRefreshError = `网络异常: ${e.message}`;
    console.log(`[feishu] 刷新 token 网络异常（第 ${refreshFailureStreak} 次，保留凭据待重试）`, e.message);
    return false;
  }

  if (!data.access_token) {
    const why = describeRefreshFailure(data);
    if (isFatalRefreshFailure(data)) {
      // 确认凭据不可用：这时才清，并让前端明确提示重新授权
      console.log('[feishu] refresh_token 已失效，需要重新授权：', why);
      refreshFailureStreak = 0;
      lastRefreshError = why;
      feishuToken = null; await saveFeishuToken();
      try { ctx.pet.host.sendToWin('feishu-status', { loggedIn: false, reason: 'AUTH_REQUIRED' }); } catch {}
      return false;
    }
    // 临时故障（5xx / 限流 / 非 JSON / 未知 code）：保留凭据，下次轮询再试
    refreshFailureStreak++;
    lastRefreshError = why;
    console.log(`[feishu] 刷新 token 暂时失败（第 ${refreshFailureStreak} 次，保留凭据待重试）`, why);
    return false;
  }

  // 刷新在途时用户点了退出（或凭据被判失效清空）：这次刷新的结果必须丢弃。
  // 否则不但会 TypeError（下面要读 feishuToken.open_id），还会把已经登出的账号
  // "复活"回来——用户点了退出却发现还连着。
  const prev = feishuToken;
  if (!prev) {
    console.log('[feishu] 刷新返回时凭据已被清空（登出或已失效），丢弃本次结果');
    return false;
  }

  // 飞书 refresh_token 是一次性轮转的：必须存下新值，旧值立刻作废。
  // refresh_token_expires_in 同时记录，用于到期前预警（原实现直接丢弃了这个字段）。
  const now = Date.now();
  feishuToken = {
    user_access_token: data.access_token,
    refresh_token: data.refresh_token || prev.refresh_token,
    expires_at: now + ((data.expires_in || 7200) - 300) * 1000,
    refresh_expires_at: data.refresh_token_expires_in
      ? now + data.refresh_token_expires_in * 1000
      : (prev.refresh_expires_at || null),
    open_id: prev.open_id || null
  };
  if (!(await saveFeishuToken())) return false;
  refreshFailureStreak = 0;
  lastRefreshError = null;
  return true;
}

// access token 到期前 10 分钟就主动刷新，别等过期后才补救
const REFRESH_LEAD_MS = 10 * 60 * 1000;

async function ensureFeishuToken() {
  if (!feishuToken) return false;
  if (Date.now() < feishuToken.expires_at - REFRESH_LEAD_MS) return true;
  if (await refreshFeishuToken()) return true;
  // 刷新没成功但凭据还在（临时故障）：只要旧 access token 没真过期就继续用
  return !!feishuToken && Date.now() < feishuToken.expires_at;
}

// 供状态查询用：凭据是否还在、refresh_token 何时到期、最近一次失败原因
function getAuthHealth() {
  if (!feishuToken) return { hasToken: false, code: 'AUTH_REQUIRED', lastError: lastRefreshError };
  return {
    hasToken: true,
    code: 'CONNECTED',
    accessExpiresAt: feishuToken.expires_at || null,
    refreshExpiresAt: feishuToken.refresh_expires_at || null,
    refreshFailureStreak,
    lastError: lastRefreshError
  };
}

// OAuth 登录：全程设备码流程。授权窗走 pet.auth.openAuthWindow（受控句柄）。
let authWin = null;   // 受控句柄 { loadURL, close, focus, isDestroyed, onClosed }
function feishuLoginProgress(text, extra) {
  ctx.pet.host.sendToSettings('feishu-login-progress', { text, ...(extra || {}) });
}
async function feishuLogin(creds) {
  const config = ctx.getConfig();
  if (authWin && !authWin.isDestroyed()) { authWin.focus(); return { ok: false, error: '授权窗口已打开' }; }
  if (creds && creds.appId !== undefined) {
    config.feishu = { ...config.feishu, appId: String(creds.appId || '').trim(), appSecret: String(creds.appSecret || '').trim() };
    if (Array.isArray(creds.scopeDomains)) config.feishu.scopeDomains = creds.scopeDomains;
    await ctx.saveConfig();
  }

  let cancelled = false;
  const isCancelled = () => cancelled;
  const openAuthWin = async (url) => {
    if (!authWin || authWin.isDestroyed()) {
      authWin = ctx.openAuthWindow({ title: '登录飞书', partition: 'persist:feishu-auth', width: 520, height: 700 });
      authWin.onClosed(() => { cancelled = true; });
    }
    await authWin.loadURL(url);
  };

  try {
    if (!config.feishu.appId || !config.feishu.appSecret) {
      feishuLoginProgress('正在向飞书申请创建应用…');
      const reg = await feishuFormPost(`${FEISHU_ACCOUNTS}/oauth/v1/app/registration`, {
        action: 'begin', archetype: 'PersonalAgent', auth_method: 'client_secret', request_user_info: 'open_id tenant_brand'
      });
      if (reg.error || !reg.device_code) throw new Error(reg.error_description || reg.error || '注册接口异常');
      await openAuthWin(reg.verification_uri_complete || `${FEISHU_BASE}/page/cli?user_code=${reg.user_code}`);
      feishuLoginProgress('请在弹出的窗口里登录飞书并确认创建应用…');
      const created = await feishuDevicePoll(
        `${FEISHU_ACCOUNTS}/oauth/v1/app/registration`,
        { action: 'poll', device_code: reg.device_code },
        reg.interval, reg.expires_in,
        (d) => (d.client_id ? d : null), isCancelled
      );
      config.feishu = { ...config.feishu, appId: created.client_id, appSecret: created.client_secret || '' };
      await ctx.saveConfig();
      if (created.user_info && created.user_info.open_id) {
        feishuToken = { ...(feishuToken || {}), open_id: created.user_info.open_id };
      }
      console.log('[feishu] 应用已自动创建', created.client_id);
      feishuLoginProgress('应用已创建，正在发起授权…', { appId: config.feishu.appId, appSecret: config.feishu.appSecret });
    }

    const { appId, appSecret } = config.feishu;
    const scope = buildFeishuScope();
    const da = await feishuFormPost(`${FEISHU_ACCOUNTS}/oauth/v1/device_authorization`,
      { client_id: appId, scope },
      { Authorization: 'Basic ' + Buffer.from(`${appId}:${appSecret}`).toString('base64') });
    if (da.error || !da.device_code) throw new Error(da.error_description || da.error || '发起授权失败');
    await openAuthWin(da.verification_uri_complete || da.verification_uri);
    feishuLoginProgress('请在弹出的窗口里确认授权…');
    const tok = await feishuDevicePoll(
      `${FEISHU_BASE}/open-apis/authen/v2/oauth/token`,
      { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: da.device_code, client_id: appId, client_secret: appSecret },
      da.interval, da.expires_in,
      (d) => (d.access_token ? d : null), isCancelled
    );
    feishuToken = {
      user_access_token: tok.access_token,
      refresh_token: tok.refresh_token || null,
      expires_at: Date.now() + ((tok.expires_in || 7200) - 300) * 1000,
      refresh_expires_at: tok.refresh_token_expires_in
        ? Date.now() + tok.refresh_token_expires_in * 1000
        : null,
      open_id: (feishuToken && feishuToken.open_id) || null
    };
    if (!(await saveFeishuToken())) throw new Error('系统安全存储不可用，飞书登录凭据未保存');
    if (!feishuToken.open_id) { try { await fetchMyOpenId(); } catch {} }
    console.log('[feishu] 登录成功 scope=', tok.scope || scope);
    ctx.pet.host.sendToWin('feishu-status', { loggedIn: true });
    // 不 await：登录流程不该被轮询注册阻塞；失败只记日志（重入由 startFeishuPolling 内部处理）
    require('./calendar').startFeishuPolling().catch((e) => console.log('[feishu] 轮询启动失败', e.message));
    return { ok: true, appId };
  } catch (e) {
    console.log('[feishu] 登录失败', e.message);
    return { ok: false, error: e.message };
  } finally {
    if (authWin && !authWin.isDestroyed()) authWin.close();
    authWin = null;
  }
}

module.exports = {
  FEISHU_BASE, FEISHU_ACCOUNTS, buildFeishuScope,
  loadFeishuToken, saveFeishuToken, getToken, logout,
  feishuFetch, feishuFormPost, feishuDevicePoll,
  getTenantAccessToken, fetchMyOpenId,
  refreshFeishuToken, ensureFeishuToken, getAuthHealth, isFatalRefreshFailure,
  feishuLogin
};
