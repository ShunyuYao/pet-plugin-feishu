// 飞书通讯录：名字/邮箱 → open_id 解析（应用身份）。从 main.js 原样搬家，行为不变。
const auth = require('./auth');

// 应用可见通讯录范围内的用户目录，缓存 10 分钟。
// 依赖后台：①应用权限 contact:user.base:readonly（读姓名）②通讯录可见范围包含相关同事
let contactDir = null; // { at, users: [{ open_id, name, email }] }
async function loadContactDirectory(force = false) {
  if (!force && contactDir && Date.now() - contactDir.at < 10 * 60 * 1000) return contactDir.users;
  const tat = await auth.getTenantAccessToken();
  if (!tat) return [];
  const headers = { Authorization: `Bearer ${tat}` };
  // 1. 取可见范围：扁平用户列表 + 可见部门列表（两个集合可能不重叠，挂在部门下的人不一定出现在扁平列表里）
  let userIds = [], deptIds = [], pageToken = '';
  try {
    do {
      const url = `/open-apis/contact/v3/scopes?user_id_type=open_id&page_size=100${pageToken ? `&page_token=${pageToken}` : ''}`;
      const data = await auth.feishuFetch(url, { headers });
      if (data.code !== 0) { console.log('[feishu] 通讯录 scopes 失败', data.code, data.msg); break; }
      const dd = data.data || {};
      userIds = userIds.concat(dd.user_ids || []);
      deptIds = deptIds.concat(dd.department_ids || []);
      pageToken = dd.has_more ? dd.page_token : '';
    } while (pageToken);
  } catch (e) { console.log('[feishu] 通讯录 scopes 异常', e.message); }
  const byId = new Map();
  // 2. 遍历可见部门的直属成员（接口直接带姓名/邮箱，不用再 batch 查）
  for (const dept of deptIds) {
    let pt = '';
    try {
      do {
        const url = `/open-apis/contact/v3/users/find_by_department?department_id=${encodeURIComponent(dept)}&user_id_type=open_id&page_size=50${pt ? `&page_token=${pt}` : ''}`;
        const data = await auth.feishuFetch(url, { headers });
        if (data.code !== 0) { console.log('[feishu] 部门成员查询失败', dept, data.code, data.msg); break; }
        const dd = data.data || {};
        for (const u of (dd.items || [])) {
          byId.set(u.open_id, { open_id: u.open_id, name: u.name || '', email: u.email || u.enterprise_email || '' });
        }
        pt = dd.has_more ? dd.page_token : '';
      } while (pt);
    } catch (e) { console.log('[feishu] 部门成员查询异常', e.message); }
  }
  // 3. 扁平列表里部门没覆盖到的，批量补姓名/邮箱（每批 50）
  const missing = userIds.filter((id) => !byId.has(id));
  for (let i = 0; i < missing.length; i += 50) {
    const qs = missing.slice(i, i + 50).map((id) => `user_ids=${encodeURIComponent(id)}`).join('&');
    try {
      const data = await auth.feishuFetch(`/open-apis/contact/v3/users/batch?user_id_type=open_id&${qs}`, { headers });
      if (data.code !== 0) { console.log('[feishu] 通讯录 batch 失败', data.code, data.msg); continue; }
      for (const u of ((data.data || {}).items || [])) {
        byId.set(u.open_id, { open_id: u.open_id, name: u.name || '', email: u.email || u.enterprise_email || '' });
      }
    } catch (e) { console.log('[feishu] 通讯录 batch 异常', e.message); }
  }
  const users = [...byId.values()];
  contactDir = { at: Date.now(), users };
  console.log('[feishu] 通讯录已加载', users.length, '人（部门', deptIds.length, '个）', users.filter((u) => !u.name).length ? '(部分无姓名, 检查 contact:user.base:readonly)' : '');
  return users;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 把一个参与人（姓名或邮箱）解析成飞书参与人对象
async function resolveAttendee(q) {
  q = String(q || '').trim();
  if (!q) return { type: 'unresolved', label: q };
  if (EMAIL_RE.test(q)) {
    // 邮箱：先当内部员工解析成 open_id，查不到则作为外部邮箱
    const tat = await auth.getTenantAccessToken();
    if (tat) {
      try {
        const data = await auth.feishuFetch('/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id', {
          method: 'POST', headers: { Authorization: `Bearer ${tat}` }, body: JSON.stringify({ emails: [q] })
        });
        if (data.code === 0) {
          const hit = ((data.data || {}).user_list || []).find((x) => x.user_id);
          if (hit) return { type: 'user', user_id: hit.user_id, label: q };
        }
      } catch (e) { console.log('[feishu] batch_get_id 异常', e.message); }
    }
    return { type: 'third_party', third_party_email: q, label: q };
  }
  // 姓名：在可见通讯录里匹配
  const users = await loadContactDirectory();
  const exact = users.filter((u) => u.name === q);
  const pool = exact.length ? exact : users.filter((u) => u.name && u.name.includes(q));
  if (pool.length === 1) return { type: 'user', user_id: pool[0].open_id, label: pool[0].name };
  if (pool.length > 1) return { type: 'ambiguous', label: q, candidates: pool.map((u) => u.name) };
  return { type: 'unresolved', label: q };
}

// 把“姓名/邮箱/空(=自己)”解析成发送目标 open_id
async function resolveMessageTarget(to) {
  to = String(to || '').trim();
  if (!to || /^(我|自己|me|myself)$/i.test(to)) {
    const t = auth.getToken();
    return { open_id: (t && t.open_id) || await auth.fetchMyOpenId(), label: '你自己' };
  }
  const r = await resolveAttendee(to);
  if (r.type === 'user') return { open_id: r.user_id, label: r.label };
  return { open_id: null, label: to, fail: r.type }; // ambiguous / unresolved / 外部邮箱(无法站内发)
}

module.exports = { loadContactDirectory, resolveAttendee, resolveMessageTarget };
