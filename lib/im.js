// 飞书 IM：bot 应用身份发消息。从 main.js 原样搬家，行为不变。
// AI 工具 send_feishu_message 随本模块注册（registerTools 由 index.init 按序调用）。
const auth = require('./auth');
const contacts = require('./contacts');

// ---- 吐梨邦发飞书消息（bot 应用身份）----
// 依赖后台：应用权限 im:message:send_as_bot（给用户/群发消息）
async function sendBotMessage(receiveId, text) {
  const tat = await auth.getTenantAccessToken();
  if (!tat) return { ok: false, error: '无法获取应用 token' };
  if (!receiveId) return { ok: false, error: '没有发送目标' };
  const data = await auth.feishuFetch('/open-apis/im/v1/messages?receive_id_type=open_id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tat}` },
    body: JSON.stringify({ receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text: String(text) }) })
  });
  if (data.code !== 0) {
    console.log('[feishu] 发消息失败', data.code, data.msg);
    return { ok: false, error: data.msg || '发送失败', code: data.code };
  }
  return { ok: true, message_id: data.data && data.data.message_id };
}

// 吐梨邦私聊“你自己”（提醒/晨报等主动消息）
async function notifyMe(text) {
  const t = auth.getToken();
  let target = t && t.open_id;
  if (!target) { try { target = await auth.fetchMyOpenId(); } catch {} }
  if (!target) return { ok: false, error: '还不知道你的 open_id，请重新登录飞书一次' };
  return sendBotMessage(target, text);
}

// 吐梨邦发飞书消息（给自己或同事）—— AI 工具 handler
async function feishuSendMessage({ to, text }) {
  if (!text || !String(text).trim()) return { ok: false, error: '消息内容是空的' };
  const t = await contacts.resolveMessageTarget(to);
  if (!t.open_id) {
    if (t.fail === 'third_party') return { ok: false, error: `${t.label} 是外部邮箱，发不了飞书站内消息` };
    if (t.fail === 'ambiguous') return { ok: false, error: `通讯录里有多个「${t.label}」，说清楚是哪个` };
    return { ok: false, error: `通讯录里没找到「${t.label}」，给我 ta 的邮箱吧` };
  }
  const r = await sendBotMessage(t.open_id, text);
  return r.ok ? { ok: true, to: t.label } : { ok: false, error: r.error };
}

function registerTools(pet) {
  pet.tools.register({
    name: 'send_feishu_message',
    schema: {
      name: 'send_feishu_message',
      description: '通过飞书发一条文字消息。to 留空（或填"我"）= 发给主人自己当提醒；填同事姓名或邮箱 = 发给同事。',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '收件人：同事姓名或邮箱；发给主人自己就留空' },
          text: { type: 'string', description: '消息内容' }
        },
        required: ['text']
      }
    },
    handler: (args) => feishuSendMessage(args),
    promptHint: '你能通过飞书发消息：主人让你"提醒我…""给自己发…"时用 send_feishu_message（to 留空发给主人自己）；主人让你"跟某人说…""告诉张三…"时用 send_feishu_message 并把 to 设为那个人。发失败(ok=false)要如实告诉主人原因。'
  });
}

module.exports = { sendBotMessage, notifyMe, feishuSendMessage, registerTools };
