# aide · HarmonyOS (ArkTS)

aide 的鸿蒙客户端——**远程协议 v2 的第三个前端**（第二个是 remote-pwa）。

## 定位

ArkTS/ArkUI 原生应用，作为 WebSocket 客户端接入中继，对话与代码能力全部跑在桌面 aide 侧：

- 复用 `relay-server`（哑中继，字节透传，协议零改动）
- 复用远程协议 v2（`src-tauri/src/remote/` 网关 + `packages/aide-sdk/src/remote.ts` 状态机）
- 桌面、remote-pwa、本工程 = 同一协议的三个消费端，**改协议三处同步提交**

## 当前状态：会话页已接入（待整体编译验证）

传输层 + 凭据持久化 + 连接管理页 + EntryAbility 注入 + 会话列表页 + 会话页均已完成
（前五步已过 hvigor 编译零告警；会话页过 ArkTS 严格静态检查）：

- `sdk/transport.ets` — AideTransport 接口 + setTransport/getTransport 门面（鸿蒙端无默认传输，启动必须显式注入）
- `sdk/remote.ets` — RemoteTransport 状态机（连接/退避/续配/invoke 对号，协议语义与上游零偏差）
- `sdk/ws-ohos.ets` — `@ohos.net.webSocket` → WsLike 适配器 + `makeOpenUrl`
- `sdk/storage.ets` — 凭据持久化（preferences，过筛自 remote-pwa 的 storage.ts）
- `conn/ConnModel.ets` — 连接应用层（@ObservedV2 单例：配对编排 / badcode·revoked 错误分型 / 启动自动续连）
- `pages/ConnectPage.ets` — 连接管理页（五态状态区）
- `pages/SessionsPage.ets` — 会话列表页（live 徽标 + 下拉刷新）；点击行 router pushUrl 进会话页
- `session/` — 会话状态层（`ChatModel` 宿主门面 + `chat/` 六件套：Store/Blocks/Transcript/Pagination/Events/Wire，
  过筛自 `useChatSession`，**含 d88dd73c hydrate 修复**）
- `pages/ChatPage.ets` — 会话页：消息时间线（用户气泡/思考折叠/工具卡片/子代理时间线）+
  发送/忙碌排队/中断 + 权限应答弹层（允许/拒绝）+ 上滚取更早；滚动策略对照 PWA「近底部才跟随」

UI 主题跟随系统深浅模式（`resources/base` 亮色 + `resources/dark` 暗色同名资源自动切换），不绑定 aide 品牌主题。

## 路线

1. ~~`@ohos.net.webSocket` 实现 `WsLike`~~ ✅
2. ~~SDK 过筛副本（按需子集）：`api.ets` + `types.ets` 已收录会话列表域~~ ✅（其余随页面扩容）
3. ~~连接管理页（配对/续配/token 持久化，参考 remote-pwa 的 ConnectView）；EntryAbility 里 `makeOpenUrl(this.context)` 注入 RemoteTransport~~ ✅
4. ~~会话列表页（live 徽标 + 下拉刷新，原生 List 风格）~~ ✅
5. ~~会话页（状态层用 @ObservedV2，对照 `useChatSession` 移植业务逻辑，带 d88dd73c 的
   hydrate 修复；消息渲染走鸿蒙原生视觉）~~ ✅（纯 Text 渲染，markdown 管线随扩容接入）

## 打开方式

DevEco Studio → Open Project → 选本目录（`ohos/`）→ 首次打开执行 Sync（IDE 自动补 hvigor wrapper 与 oh_modules）。

注意：

- `compatibleSdkVersion` 保守设为 `5.0.0(12)`，按本机 SDK 版本在 `build-profile.json5` 上调
- 命令行构建需 wrapper（`hvigorw`），由 IDE Sync 生成，不在库内
- 本工程**不进 pnpm workspace**（构建体系独立：ohpm/hvigor）；aide 根 .gitignore 不为本工程加任何条目，产物由本目录 `.gitignore` 自治

## 结构

```
ohos/
├── AppScope/          应用级配置与资源（bundleName: com.aide.ohos）
├── entry/             主模块（入口 ability + 页面）
│   └── src/main/
│       ├── ets/       ArkTS 源码
│       └── resources/ 模块资源
├── hvigor/            构建系统版本声明
├── build-profile.json5  工程构建配置（SDK 版本、模块列表）
└── oh-package.json5     工程依赖（ohpm）
```
