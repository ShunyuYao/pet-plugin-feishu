// 飞书日历：主日历定位、日程增查、参与人、会议提醒轮询。从 main.js 原样搬家，行为不变。
// AI 工具 create_calendar_event / query_calendar_events 随本模块注册。
const ctx = require('./ctx');
const auth = require('./auth');
const contacts = require('./contacts');
const im = require('./im');

let feishuCalendarId = null;  // 主日历 ID，登录后自动获取
let feishuCalendarIdPromise = null;
let feishuPollTimer = null;
let feishuPollQueue = Promise.resolve();
const notifiedEvents = new Set();

async function ensureCalendarId() {
  if (feishuCalendarId) return feishuCalendarId;
  if (feishuCalendarIdPromise) return feishuCalendarIdPromise;
  feishuCalendarIdPromise = (async () => {
    if (!(await auth.ensureFeishuToken())) return null;
    try {
    const data = await auth.feishuFetch('/open-apis/calendar/v4/calendars/primary', {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.getToken().user_access_token}` },
      body: JSON.stringify({})
    });
    if (data.code !== 0) {
      console.log('[feishu] 获取主日历失败', data.code, data.msg);
      if (data.code === 99991679 || data.code === 99991677) {
        console.log('[feishu] 权限不足：当前 token 缺少 calendar scope，请在设置里重新登录飞书');
      }
      return null;
    }
    const cals = data.data && data.data.calendars;
    if (cals && cals.length > 0) {
      feishuCalendarId = cals[0].calendar && cals[0].calendar.calendar_id || null;
      console.log('[feishu] 主日历 ID:', feishuCalendarId);
    }
    } catch (e) { console.log('[feishu] 获取主日历异常', e.message); }
    return feishuCalendarId;
  })();
  try { return await feishuCalendarIdPromise; }
  finally { feishuCalendarIdPromise = null; }
}

// 给日程添加参与人并发通知
async function addEventAttendees(calId, eventId, list) {
  const payload = [], added = [], failed = [];
  for (const q of list) {
    const r = await contacts.resolveAttendee(q);
    if (r.type === 'user') { payload.push({ type: 'user', user_id: r.user_id }); added.push(r.label); }
    else if (r.type === 'third_party') { payload.push({ type: 'third_party', third_party_email: r.third_party_email }); added.push(`${r.label}(外部邮箱)`); }
    else if (r.type === 'ambiguous') failed.push(`${r.label}(通讯录里有多个同名：${r.candidates.join('、')}，请用邮箱指定)`);
    else failed.push(`${r.label}(通讯录里没找到，给我 ta 的邮箱吧)`);
  }
  if (payload.length) {
    const data = await auth.feishuFetch(`/open-apis/calendar/v4/calendars/${calId}/events/${eventId}/attendees?user_id_type=open_id`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.getToken().user_access_token}` },
      body: JSON.stringify({ attendees: payload, need_notification: true })
    });
    if (data.code !== 0) {
      console.log('[feishu] 加参与人失败', data.code, data.msg);
      return { added: [], failed: list.map(String), error: data.msg || '加参与人失败' };
    }
  }
  return { added, failed };
}

// 飞书日历：创建日程
async function feishuCreateEvent({ summary, start_time, end_time, description, attendees }) {
  const calId = await ensureCalendarId();
  if (!calId) return { ok: false, error: '飞书未登录或无法获取日历' };
  const body = {
    summary,
    start_time: { timestamp: String(Math.floor(new Date(start_time).getTime() / 1000)) },
    end_time: { timestamp: String(Math.floor(new Date(end_time).getTime() / 1000)) }
  };
  if (description) body.description = description;
  const data = await auth.feishuFetch(`/open-apis/calendar/v4/calendars/${calId}/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth.getToken().user_access_token}` },
    body: JSON.stringify(body)
  });
  console.log('[feishu] 创建日程:', data.code, summary);
  if (data.code !== 0) return { ok: false, error: data.msg || '创建失败' };
  const eventId = data.data && data.data.event && data.data.event.event_id;
  const result = { ok: true, event_id: eventId, summary, start_time, end_time };
  if (eventId && Array.isArray(attendees) && attendees.length) {
    const att = await addEventAttendees(calId, eventId, attendees);
    result.attendees_added = att.added;     // 已加入并已发通知
    result.attendees_failed = att.failed;   // 没解析到的（需邮箱/歧义）
    if (att.error) result.attendees_error = att.error;
    console.log('[feishu] 参与人:', JSON.stringify(att));
  }
  return result;
}

// 飞书日历：查询日程
// 用 instance_view（日程视图）而不是 events 列表：列表接口对重复性日程只返回系列
// 首次发生的时间，instance_view 会展开成查询区间内实际发生的实例
async function feishuQueryEvents({ start_time, end_time }) {
  const calId = await ensureCalendarId();
  if (!calId) return { ok: false, error: '飞书未登录或无法获取日历' };
  const startSec = Math.floor(new Date(start_time).getTime() / 1000);
  // instance_view 限制查询区间小于 40 天
  const maxSpan = 40 * 24 * 3600 - 1;
  const endSec = Math.min(Math.floor(new Date(end_time).getTime() / 1000), startSec + maxSpan);
  const data = await auth.feishuFetch(
    `/open-apis/calendar/v4/calendars/${calId}/events/instance_view?start_time=${startSec}&end_time=${endSec}`,
    { headers: { Authorization: `Bearer ${auth.getToken().user_access_token}` } }
  );
  if (data.code !== 0) return { ok: false, error: data.msg || '查询失败' };
  const items = ((data.data && data.data.items) || [])
    .filter((ev) => ev.status !== 'cancelled')
    .sort((a, b) =>
      Number((a.start_time && a.start_time.timestamp) || 0) -
      Number((b.start_time && b.start_time.timestamp) || 0));
  return {
    ok: true,
    count: items.length,
    events: items.map((ev) => {
      const s = ev.start_time && ev.start_time.timestamp;
      const e = ev.end_time && ev.end_time.timestamp;
      return {
        summary: (ev.summary || '').replace(/<[^>]*>/g, ''),
        start: s ? new Date(Number(s) * 1000).toLocaleString('zh-CN') : '',
        end: e ? new Date(Number(e) * 1000).toLocaleString('zh-CN') : '',
        startTs: s ? Number(s) : null,
        endTs: e ? Number(e) : null,
        status: ev.status
      };
    })
  };
}

function feishuEventToProviderEvent(ev) {
  const start = ev.start_time || {};
  const end = ev.end_time || {};
  const startAt = start.timestamp
    ? new Date(Number(start.timestamp) * 1000).toISOString()
    : String(start.date || '');
  const endAt = end.timestamp
    ? new Date(Number(end.timestamp) * 1000).toISOString()
    : String(end.date || '');
  return {
    id: String(ev.event_id || `${startAt}:${ev.summary || ''}`),
    rawId: ev.event_id ? String(ev.event_id) : undefined,
    calendarId: feishuCalendarId || undefined,
    title: (ev.summary || '').replace(/<[^>]*>/g, ''),
    description: ev.description ? String(ev.description).replace(/<[^>]*>/g, '') : undefined,
    startAt,
    endAt,
    allDay: !!start.date,
    status: ev.status === 'cancelled' ? 'cancelled' : 'confirmed'
  };
}

// access token 过期类错误码：刷新一次就能继续用，不代表用户需要重新授权。
// 99991677 token expired / 99991668 无效 access token / 99991664 token 校验失败。
const TOKEN_STALE_CODES = new Set([99991677, 99991668, 99991664]);

async function queryProviderEvents({ startAt, endAt }) {
  const startSec = Math.floor(new Date(startAt).getTime() / 1000);
  const maxSpan = 40 * 24 * 3600 - 1;
  const endSec = Math.min(Math.floor(new Date(endAt).getTime() / 1000), startSec + maxSpan);

  // token 只是过期（凭据仍有效）时刷新一次重试，别让上层当成"未连接"去弹重新授权引导：
  // calendar-service 的 providerFailure 会把 99991677/token expired 翻译成
  // CALENDAR_NOT_CONNECTED，看板据此弹「连接日历」卡——可用户明明连着，
  // refresh_token 也好好的，只是没人去刷 access token（bug表 recvrPuLTebo6N 真根因）。
  const attempt = async () => {
    const calId = await ensureCalendarId();
    if (!calId) throw new Error('飞书未登录或无法获取日历');
    const data = await auth.feishuFetch(
      `/open-apis/calendar/v4/calendars/${calId}/events/instance_view?start_time=${startSec}&end_time=${endSec}`,
      { headers: { Authorization: `Bearer ${auth.getToken().user_access_token}` } }
    );
    return data;
  };

  let data = await attempt();
  if (data.code !== 0 && TOKEN_STALE_CODES.has(data.code) && auth.getToken()) {
    console.log('[feishu] 日历查询遇到 token 过期，刷新后重试一次：', data.code, data.msg);
    if (await auth.refreshFeishuToken()) {
      feishuCalendarId = null;          // 换了 token，主日历重新确认一次
      feishuCalendarIdPromise = null;
      data = await attempt();
    } else if (auth.getToken()) {
      // 刷新没成功但凭据还在 = 断网/5xx/限流等临时故障，不是掉线。
      // 必须改写错误文案：原始的 "token expired" 会被 calendar-service 的
      // providerFailure 正则翻译成 CALENDAR_NOT_CONNECTED，看板据此弹「连接日历」，
      // 用户明明连着却被要求重新授权——正是本 bug 的表象。
      // 换成普通查询失败 → 归到 CALENDAR_QUERY_FAILED，看板只提示查询失败不弹引导。
      throw new Error('飞书日历暂时不可用（token 刷新失败，稍后自动重试）');
    }
  }
  if (data.code !== 0) throw new Error(data.msg || '查询飞书日程失败');
  return ((data.data && data.data.items) || []).map(feishuEventToProviderEvent);
}

async function createProviderEvent(input) {
  const result = await feishuCreateEvent({
    summary: input.title,
    start_time: input.startAt,
    end_time: input.endAt,
    description: input.description,
    attendees: input.attendees
  });
  if (!result.ok) throw new Error(result.error || '创建飞书日程失败');
  return {
    id: String(result.event_id || `${input.startAt}:${input.title || ''}`),
    rawId: result.event_id ? String(result.event_id) : undefined,
    calendarId: feishuCalendarId || undefined,
    title: String(input.title || ''),
    description: input.description,
    startAt: input.startAt,
    endAt: input.endAt,
    allDay: !!input.allDay,
    status: 'confirmed'
  };
}

// ---- 会议提醒轮询 ----
// 查询日历事件
async function fetchUpcomingEvents() {
  const calId = await ensureCalendarId();
  if (!calId) return [];
  const now = Math.floor(Date.now() / 1000);
  const ahead = (ctx.getConfig().feishu.reminderMin || 5) * 60;
  const timeMin = String(now);
  const timeMax = String(now + ahead);
  // instance_view 展开重复日程，拿到的是本次实例的实际时间（events 列表只给系列首次时间）
  const data = await auth.feishuFetch(
    `/open-apis/calendar/v4/calendars/${calId}/events/instance_view?start_time=${timeMin}&end_time=${timeMax}`,
    { headers: { Authorization: `Bearer ${auth.getToken().user_access_token}` } }
  );
  if (data.code !== 0) {
    console.log('[feishu] 日历查询失败', data.code, data.msg);
    if (data.code === 99991668 || data.code === 99991664) { await auth.refreshFeishuToken(); }
    return [];
  }
  return ((data.data && data.data.items) || []).filter((ev) => ev.status !== 'cancelled');
}

async function pollFeishuCalendar() {
  try {
    const events = await fetchUpcomingEvents();
    for (const ev of events) {
      const id = ev.event_id;
      if (notifiedEvents.has(id)) continue;
      notifiedEvents.add(id);
      const summary = (ev.summary && ev.summary.replace(/<[^>]*>/g, '')) || '(无标题会议)';
      const startTs = ev.start_time && (ev.start_time.timestamp || ev.start_time.date);
      let startStr = '';
      if (startTs && Number(startTs)) {
        const d = new Date(Number(startTs) * 1000);
        startStr = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
      }
      console.log('[feishu] 提醒会议:', summary, startStr);
      ctx.wake();
      // US-014：会议提醒从气泡升级为中型卡（稍后提醒/知道了）；数据源不变仍是本轮询
      ctx.meetingCard({ title: summary, timeText: startStr, eventId: id, minsAhead: ctx.getConfig().feishu.reminderMin || 5 });
      ctx.speak(`主人，${startStr || '马上'}有个会议：${summary}`);
      // 吐梨邦同时私聊你（im:message 权限生效后才会真发，否则静默失败）
      const t = auth.getToken();
      if (t && t.open_id) {
        im.notifyMe(`⏰ 吐梨邦提醒：${startStr ? startStr + ' ' : ''}有个会「${summary}」，别忘啦～`).catch(() => {});
      }
    }
  } catch (e) { console.log('[feishu] 轮询异常', e.message); }
}

// 跨进程后 scheduler.every 返回 Promise<taskId>：**必须 await 后再存 id**，
// 否则 cancel 拿到的是 Promise，每次登录/启动都叠加一个 2 分钟轮询（US-PQ03 裁决点）。
// feishuPollPending 处理「上一次注册还没落地就又被调用」（登录与启动序列可能并发）。
// 所有启停串行排队：登录回调与启动序列可能并发，若两次 start 同时进来，
// 各自都会看到 feishuPollTimer 还是 null 而各注册一个，旧的再也取不回来。
function queuePollOp(op) {
  feishuPollQueue = feishuPollQueue.then(op, op);
  return feishuPollQueue;
}

async function cancelPollTimer() {
  const prev = feishuPollTimer;
  feishuPollTimer = null;
  if (prev) await Promise.resolve(ctx.scheduler().cancel(prev)).catch(() => {});
}

function stopFeishuPolling() {
  return queuePollOp(cancelPollTimer);
}

function startFeishuPolling() {
  return queuePollOp(async () => {
    await cancelPollTimer();
    if (!auth.getToken()) return;
    pollFeishuCalendar();
    // 定时器归宿主管
    feishuPollTimer = await ctx.scheduler().every(2 * 60 * 1000, pollFeishuCalendar);
    console.log('[feishu] 日历轮询已启动，每2分钟检查');
  });
}

// 登出时清空日历侧状态（原 feishu-logout handler 里的逻辑）
async function onLogout() {
  feishuCalendarId = null;
  feishuCalendarIdPromise = null;
  await stopFeishuPolling();
  notifiedEvents.clear();
}

function registerTools(pet) {
  pet.tools.register({
    name: 'create_calendar_event',
    schema: {
      name: 'create_calendar_event',
      description: '在飞书日历中创建日程/会议',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '日程标题' },
          start_time: { type: 'string', description: '开始时间，ISO 8601 格式，如 2026-07-04T15:00:00+08:00' },
          end_time: { type: 'string', description: '结束时间，ISO 8601 格式。如果用户没说时长默认1小时' },
          description: { type: 'string', description: '日程描述（可选）' },
          attendees: { type: 'array', items: { type: 'string' }, description: '参与人（可选）：同事姓名或邮箱，会自动加入日程并给他们发飞书/邮件通知。例如 ["张三","li@corp.com"]' }
        },
        required: ['summary', 'start_time', 'end_time']
      }
    },
    handler: (args) => feishuCreateEvent(args),
    promptHint:
      '你可以帮主人创建飞书日历日程、查询今天的日程。当主人让你建会议/日程时，用 create_calendar_event 工具；当主人问今天有什么会/日程时，用 query_calendar_events 工具。' +
      '如果主人提到要拉某人一起开会（如"约张三"、"和李四开会"），把这些人放进 create_calendar_event 的 attendees 参数（姓名或邮箱都行），系统会自动邀请并通知他们。建完后如果结果里 attendees_failed 有人没约到，要如实告诉主人（比如让主人补一个邮箱）。'
  });

  pet.tools.register({
    name: 'query_calendar_events',
    schema: {
      name: 'query_calendar_events',
      description: '查询飞书日历中指定时间范围的日程',
      parameters: {
        type: 'object',
        properties: {
          start_time: { type: 'string', description: '查询起始时间，ISO 8601' },
          end_time: { type: 'string', description: '查询结束时间，ISO 8601' }
        },
        required: ['start_time', 'end_time']
      }
    },
    handler: (args) => feishuQueryEvents(args)
    // 触发话术并在 create_calendar_event 的 promptHint 里（两工具一句话说清）
  });
}

module.exports = {
  ensureCalendarId, addEventAttendees, feishuCreateEvent, feishuQueryEvents,
  feishuEventToProviderEvent, queryProviderEvents, createProviderEvent,
  fetchUpcomingEvents, pollFeishuCalendar, startFeishuPolling, onLogout, registerTools
};
