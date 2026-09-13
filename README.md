# 飞书 · Feishu

[中文](#中文) · [English](#english)

## 中文

吐梨邦（Desktop Pet）的官方市场飞书插件。**按需安装，可卸载，不随宿主预装。**
公开源码由 [ShunyuYao](https://github.com/ShunyuYao) 维护，与飞书公司的官方客户端无关。

### 安装与兼容

需要 **吐梨邦 0.21.0 或更高版本，且包含 `host:feishu` 兼容接口**。宿主目前处于测试阶段，请通过受邀测试渠道获取。旧版本有同名内置插件，请先升级，不要覆盖安装。

1. 在吐梨邦打开「设置 → 插件 → 市场」。
2. 选择「飞书」，查看权限后安装。
3. 在已安装插件的飞书设置中登录并授权；可以自动创建个人应用，也可填写自己的 App ID / App Secret。
4. 选择日历、消息等所需授权范围。可在设置中退出登录，在插件管理中卸载。

官方登记表：[pet-plugin-registry](https://github.com/ShunyuYao/pet-plugin-registry)。
手动安装使用 [Releases](https://github.com/ShunyuYao/pet-plugin-feishu/releases) 中的 **`plugin.zip`**，不要使用 GitHub 自动生成的 Source code ZIP。

### 功能

- 飞书设备码登录、个人应用创建、凭据加密保存和旧版凭据迁移。
- 日历查询与创建、参会人解析、会议提醒。
- 飞书消息发送、晨报和日报。
- 为宿主 AI 提供对应工具，并向宿主看板注册日历数据源。
- 断网或临时服务故障时保留凭据；恢复网络后重试，明确失效时才要求重新授权。

### 权限和隐私

| 权限 | 用途 |
| --- | --- |
| `net:open.feishu.cn` | 飞书日历、通讯录、消息和 token API |
| `net:accounts.feishu.cn` | 应用创建与设备授权 |
| `net:passport.feishu.cn` | 飞书登录网页跳转 |
| `secrets` | 使用宿主加密仓保存 token，不明文写入源码或配置 |
| `scheduler` | 日历轮询和定时报告 |
| `auth-window` | 打开受控、隔离的飞书授权窗口 |
| `pet` | 会议提醒、播报与宠物动作 |
| `tools` / `calendar-provider` | 注册 AI 工具及日历数据源 |
| `host:feishu` | 连接现有飞书设置、登录进度与旧凭据迁移 |

`host:feishu` 是单独授权的迁移兼容权限，不是通用 SDK 的冻结接口，也不把插件标记为内置。宿主只交出 `config.feishu`，只允许飞书状态/进度消息及 `feishu-token.json` 旧文件迁移。App Secret 由宿主配置加密仓保存，token 通过 `pet.secrets` 保存；插件不直接读取电脑文件或执行系统命令。

日历、收件人及要发送的消息按功能需要提交到飞书。是否送给 AI 取决于用户使用的宿主 AI 功能和配置；本插件没有独立遥测服务。卸载停止插件进程、日历数据源、任务与授权窗；卸载的数据保留策略由宿主管理。退出登录清除本地 token，**不等于在飞书服务端撤销授权**；服务端授权请在飞书管理页面处理。

### 开发与发布

Node.js 22+、Python 3.9+；无需运行时 npm 依赖。

```sh
npm ci --ignore-scripts
npm test
npm run build
```

`dist/plugin.zip` 使用 `package-files.json` 白名单，固定文件顺序、时间戳和权限；`dist/plugin.zip.sha256` 用于市场完整性校验。测试、私有环境文件、Git 元数据不会进入安装包。

`npm test` 覆盖 token 刷新、旧凭据迁移、连接一致性、设备授权成功/失败/取消、确定性打包和越界文件拒绝。宿主 IPC、权限弹窗、看板与实际市场安装的端到端测试在宿主项目运行。自动测试使用模拟服务，不能替代真实账号登录验收。

更新 `manifest.json` 和 `package.json` 的版本，运行测试，提交后推送对应 `vX.Y.Z` 标签。公开 GitHub Actions 会重新测试、构建并发布 `plugin.zip` 和校验文件；随后更新官方登记表的版本、权限、最低宿主版本与实际资产 SHA-256。插件不会自行下载执行更新。

### 源码来源与许可

从吐梨邦原飞书插件迁出，保持插件 ID `feishu` 以兼容已有数据。仓库中的源码公开供审阅；当前未授予独立开源许可证（`UNLICENSED`），不应将公开可见理解为任意再分发许可。原宿主中的回归测试仍保留；本项目携带其中可独立运行的插件测试。

## English

The official marketplace Feishu integration for 吐梨邦 (Desktop Pet). **Install it when needed and uninstall it from plugin management; it is not bundled with the host.** Maintained by [ShunyuYao](https://github.com/ShunyuYao), not by the Feishu client team.

### Installation and compatibility

Requires **Desktop Pet 0.21.0+ with the `host:feishu` compatibility capability**. The host is currently in testing and is available through invitation-only testing channels. Older hosts contain a built-in plugin with the same ID: upgrade first rather than overwriting it.

1. Open Settings → Plugins → Marketplace in Desktop Pet.
2. Select Feishu, review the permissions, and install.
3. Sign in from the installed plugin's Feishu settings. Create a personal application through the authorization flow, or supply your own App ID and App Secret.
4. Choose the scopes you need. Sign out in settings or uninstall through plugin management.

The [official registry](https://github.com/ShunyuYao/pet-plugin-registry) supplies the listing. For manual installation, use **`plugin.zip`** from [Releases](https://github.com/ShunyuYao/pet-plugin-feishu/releases), not GitHub's automatically generated source archive.

### Features

- Device authorization, personal application creation, encrypted credentials, and migration of legacy tokens.
- Calendar queries and creation, attendee resolution, and meeting reminders.
- Feishu messaging, morning summaries, and daily reports.
- AI tools and a calendar provider for the host dashboard.
- Credentials survive temporary network/service failures; retries recover the connection, while confirmed invalid tokens require authorization again.

### Permissions and privacy

| Permission | Purpose |
| --- | --- |
| `net:open.feishu.cn` | Calendar, contacts, messages, and token APIs |
| `net:accounts.feishu.cn` | Application registration and device authorization |
| `net:passport.feishu.cn` | Feishu sign-in page navigation |
| `secrets` | Token storage through the host's encrypted secret store |
| `scheduler` | Calendar polling and scheduled reports |
| `auth-window` | A controlled, isolated authorization window |
| `pet` | Reminders, speech, and pet animations |
| `tools` / `calendar-provider` | AI tools and the dashboard calendar provider |
| `host:feishu` | Existing Feishu settings, login progress, and legacy credential migration |

`host:feishu` is a separately consented migration capability, not a frozen general SDK interface or built-in status. It exposes only `config.feishu`, the Feishu status/progress channels, and migration of the legacy `feishu-token.json` file. The host encrypts the App Secret in its configuration vault; tokens use `pet.secrets`. The plugin does not directly access local files or execute system commands.

Calendar data, recipients, and messages are sent to Feishu as needed. Data passed to AI depends on the host features and AI configuration you use; this plugin has no separate telemetry service. Uninstalling stops its process, calendar provider, schedules, and authorization windows; the host controls data retention on removal. Signing out clears local tokens; **it does not revoke the authorization on Feishu's servers**. Manage server-side authorization in Feishu.

### Development and releases

Use Node.js 22+ and Python 3.9+. No runtime npm dependencies are required.

```sh
npm ci --ignore-scripts
npm test
npm run build
```

The build creates `dist/plugin.zip` and `dist/plugin.zip.sha256` from the explicit `package-files.json` allowlist. File order, timestamps, and modes are deterministic. Tests, private environment files, and Git metadata stay out of the package.

The test gate covers refresh resilience, legacy migration, connection consistency, device authorization success/failure/cancellation, deterministic packaging, and invalid paths. The host project owns end-to-end tests of IPC, permission dialogs, the dashboard, and real marketplace installation. Mock services in automation do not establish successful authorization with a real Feishu account.

Update both version fields, run tests, commit, and push the matching `vX.Y.Z` tag. Public GitHub Actions reruns the gate and publishes the ZIP and checksum. Then update the registry's version, permissions, minimum host version, and SHA-256 from the actual release asset. The plugin never downloads and executes its own updates.

### Origin and license

Extracted from the original Desktop Pet Feishu plugin. The `feishu` ID is preserved for existing data. The source is public for inspection; no separate open-source license has been granted (`UNLICENSED`). Public visibility is not permission for unrestricted redistribution. Original host regression tests remain in the host repository; this project carries their independently runnable plugin portions.
