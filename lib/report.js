// 飞书晨报/日报：今日日程汇总 → 私聊自己 + 渲染层气泡/TTS 播报，含定时调度。
// 从 main.js 原样搬家，行为不变。AI 工具 send_daily_report 随本模块注册。
const ctx = require('./ctx');
const auth = require('./auth');
const calendar = require('./calendar');
const im = require('./im');

function reportDayRange() {
  const now = new Date();
  const s = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const e = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  return { start_time: s.toISOString(), end_time: e.toISOString() };
}

// 今日日程文本 + 数量。返回 { count, lines }，无飞书/失败返回 null
async function buildTodaySchedule() {
  if (!auth.getToken()) return null;
  const r = await calendar.feishuQueryEvents(reportDayRange());
  if (!r.ok) return null;
  const evs = (r.events || []).filter((e) => (e.status || '') !== 'cancelled' && (e.summary || '').trim());
  const lines = evs.map((e) => {
    const hm = (e.start || '').split(' ')[1] || e.start || '';
    return `· ${hm.slice(0, 5)} ${e.summary.trim()}`;
  });
  return { count: evs.length, lines };
}

// 发送晨报/日报：飞书私聊 + 通知渲染层气泡/TTS
async function sendDailyReport(kind) {
  const sc = await buildTodaySchedule();
  if (!sc) return { ok: false, error: '飞书未登录或日程查询失败' };
  let text, speak;
  if (kind === 'evening') {
    text = sc.count
      ? `🌆 今天辛苦啦！今天一共 ${sc.count} 个日程：\n${sc.lines.join('\n')}\n早点休息~`
      : '🌆 今天没有安排日程，辛苦啦，好好休息~';
    speak = sc.count ? `今天一共${sc.count}个日程，辛苦啦，早点休息。` : '今天没有日程，好好休息。';
  } else {
    text = sc.count
      ? `🌅 早上好！今天有 ${sc.count} 个日程：\n${sc.lines.join('\n')}\n加油鸭！`
      : '🌅 早上好！今天暂时没有日程，轻松一天~';
    speak = sc.count ? `早上好，今天有${sc.count}个日程，加油。` : '早上好，今天没有日程，轻松一天。';
  }
  await im.notifyMe(text);
  ctx.wake();
  ctx.bubble(text, 9000);
  if (speak) ctx.speak(speak);
  console.log('[feishu] 已发', kind === 'evening' ? '日报' : '晨报', '日程数', sc.count);
  return { ok: true, count: sc.count };
}

// 每分钟检查是否到晨报/日报时间（按天去重）。
// 调度归宿主的 pet.scheduler 管（插件禁用/卸载时宿主统一清理，不留孤儿 timer）。
let reportSentKey = { morning: '', evening: '' };
// 跨进程后 scheduler.every 返回 Promise<taskId>：**必须 await 后再存 id**，
// 否则 cancel 收到的是个 Promise，旧定时器永不回收（US-PQ03 裁决点）。
// reportTimerPending 覆盖「上一次注册还没落地就又被调用」的重入窗口。
// 启停串行排队，理由同 calendar.js：并发两次调用各自都会看到 reportTimerId 还是 null。
let reportTimerId = null;
let reportQueue = Promise.resolve();
function startReportScheduler() {
  const run = async () => {
    const prev = reportTimerId;
    reportTimerId = null;
    if (prev) await Promise.resolve(ctx.scheduler().cancel(prev)).catch(() => {});
    await registerReportTimer();
  };
  reportQueue = reportQueue.then(run, run);
  return reportQueue;
}
async function registerReportTimer() {
  const tick = () => {
    if (!auth.getToken()) return;
    const config = ctx.getConfig();
    const now = new Date();
    const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    const jobs = [['morning', config.feishu.morningReport], ['evening', config.feishu.eveningReport]];
    for (const [kind, t] of jobs) {
      if (t && t === hm && reportSentKey[kind] !== day) {
        reportSentKey[kind] = day;
        sendDailyReport(kind).catch((e) => console.log('[feishu] 报告失败', e.message));
      }
    }
  };
  reportTimerId = await ctx.scheduler().every(60 * 1000, tick);
  console.log('[feishu] 晨报/日报调度已启动', ctx.getConfig().feishu.morningReport, ctx.getConfig().feishu.eveningReport);
}

function registerTools(pet) {
  pet.tools.register({
    name: 'send_daily_report',
    schema: {
      name: 'send_daily_report',
      description: '生成并发送今日日程播报（晨报/日报），会发飞书消息并气泡播报。主人说"给我发个晨报/播报今天日程/今天日报"时用。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['morning', 'evening'], description: '晨报 morning / 日报 evening，默认 morning' }
        }
      }
    },
    handler: (args) => sendDailyReport(args && args.kind === 'evening' ? 'evening' : 'morning'),
    promptHint: '主人让你"播报今天日程/发个晨报/来个日报"时用 send_daily_report（早上用 morning，傍晚用 evening）。'
  });
}

module.exports = { buildTodaySchedule, sendDailyReport, startReportScheduler, registerTools };
