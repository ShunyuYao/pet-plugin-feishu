// 飞书插件内部共享上下文。飞书从内核搬成「内置特权插件」后（阶段二½），
// 依赖不再由宿主 main.js 直接注入，而是从受控 SDK（pet）派生——飞书必须走
// manifest + SDK 正门，不许 require 宿主内核模块（它是 SDK 完备性的压力测试）。
// host:feishu 是经用户同意的兼容权限，仅能读写 config.feishu；token 走 pet.secrets 加密仓。
//
// US-PQ03 起本插件跑在 utilityProcess 子进程里，SDK 调用全部经 RPC：
// - getConfig() 仍是**同步**的（子进程持有 config 副本，见 tool-host.js 的 configCache），
//   故十余处 `ctx.getConfig().feishu.x` 无需改成 await；
// - saveConfig() 变成**异步**（要把副本回传主进程落盘），调用方需 await；
// - secrets 三个方法变成异步，故这里改为 await 形式的 getSecret/setSecret/delSecret。
module.exports = {
  pet: null,            // 受控 SDK（activate 时注入）
  init(pet) { this.pet = pet; },
  getConfig() { return this.pet.host.getConfig(); },
  saveConfig() { return this.pet.host.saveConfig(); },
  getSecret(key) { return this.pet.secrets.get(key); },
  setSecret(key, value) { return this.pet.secrets.set(key, value); },
  delSecret(key) { return this.pet.secrets.delete(key); },
  // US-PQ04：旧版明文 token 一次性迁移用。插件不再 require('fs')——读/删都走特权 SDK，
  // 由主进程限定在 userData 根目录的裸文件名。
  readLegacyFile(name) { return this.pet.host.readLegacyFile(name); },
  removeLegacyFile(name) { return this.pet.host.removeLegacyFile(name); },
  // 提醒/晨报路径简化：直接调 pet.pet.*，删掉原 feishu-meeting/feishu-report 专用 channel
  bubble(text, ms) { return this.pet.pet.bubble(text, ms); },
  speak(text) { return this.pet.pet.speak(text); },
  // 会议提醒卡（US-014）：呈现升级为中型卡（稍后提醒/知道了），数据源仍是本插件日历轮询
  meetingCard(opts) { return this.pet.pet.meetingCard(opts || {}); },
  wake() { return this.pet.pet.playAnim('wake'); },   // 提醒前唤醒（睡觉/待机时才会切）
  // 设备码授权开真窗：走高权限原语 pet.auth.openAuthWindow（拿受控句柄，非窗口本体）
  openAuthWindow(opts) { return this.pet.auth.openAuthWindow(opts); },
  // 联网走白名单 pet.net.fetch（返回 {status, body}）
  netFetch(url, opts) { return this.pet.net.fetch(url, opts); },
  scheduler() { return this.pet.scheduler; }
};
