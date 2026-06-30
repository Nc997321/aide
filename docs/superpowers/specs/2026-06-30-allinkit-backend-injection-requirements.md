# AllInKit 后端可注入 — 需求书

日期：2026-06-30
面向：AllInKit 团队
来源：Aide × AllInKit 打通设计（Aide 侧 spec：`2026-06-30-aide-allinkit-integration-design.md`）

## 一句话背景

Aide（Claude Code CLI 的 Tauri v2 桌面壳）希望以 path 依赖嵌入 AllInKit 的插件运行时，新增一个独立的「工具」面板来装并运行 AllInKit 插件。Aide 定位不变，AllInKit 借代码进 Aide，两个产品仍各自独立存在、各自演进。

## 为什么要找 AllInKit

Aide 想在嵌入运行时后，**复用 Aide 自己已有的宿主能力实现**（clipboard / fs / notify / dialog 已有 Tauri 命令），而不是在 Aide 进程里再跑一套 AllInKit 的同名实现——否则会出现两套 clipboard/fs/notify/dialog 并存，行为不一致、维护重复。

为此，需要 AllInKit 把宿主能力后端做成**可从外部注入**。这次改造也让 AllInKit「可被任意宿主嵌入」，对 AllInKit 作为独立产品是净收益。

## 目标

让 AllInKit 的插件运行时（`aik-host`）能被外部 Tauri 应用以 path 依赖引入，并由外部宿主用自己的实现替换部分宿主能力后端，未替换的回退 AllInKit 默认实现。

## 需求

### R1. 能力后端可注入

`clipboard` / `fs` / `notify` / `dialog` / `http` / `kv` 六个能力的执行后端，外部宿主能用自己的实现替换默认实现。

- 具体 trait 形状（一个聚合 trait 还是六个独立 trait）、方法粒度，由 AllInKit 自决。
- 能力清单与现有 `plugin.toml` 声明 + `CapabilityGate` default-deny 模型保持一致，不因可注入而改变安全语义。

### R2. builder 构造路径

提供类似下述的构造方式，未传入的能力回退默认实现：

```rust
HostServices::builder(gate, kv_root)
    .with_clipboard(impl)
    .with_fs(impl)
    .with_notify(impl)
    .with_dialog(impl)
    // http / kv 用默认
    .build()
    .install();
```

（方法名仅为示意，AllInKit 可自定。）

### R3. 默认实现不破坏现有行为

当外部宿主不注入任何后端（全默认）时，AllInKit 现有外壳（`aik-tauri`）与现有 e2e（`base64-tool` / `kv-tool` dogfood）行为完全不变。

### R4. 公开 API

`aik-host` 对外导出各后端 trait、默认实现、builder，供外部宿主依赖与实现。`publish = false` 不影响本地 path 依赖。

### R5. 契约稳定

后端 trait 的方法签名覆盖现有各能力方法的能力（参数 / 返回 `AikResult<Value>` / 错误码）。签名如需变动，请在交付前同步，以便 Aide 侧注入实现可对齐。

## Aide 侧的注入计划（供参考，非本需求书约束）

| 能力 | Aide 计划 | 备注 |
|---|---|---|
| clipboard | 注入 Aide 现有实现 | Aide 已有剪贴板命令 |
| fs | 注入 Aide 现有实现 | Aide 会确保路径越界检查对齐 AllInKit fs 能力的安全语义 |
| notify | 注入 Aide 现有实现 | Aide 强制 `app_id("com.aide.app")` |
| dialog | 注入 Aide 现有实现 | 对齐 trait 的 dialog 方法集 |
| http | 用 AllInKit 默认 | Aide 无此能力 |
| kv | 用 AllInKit 默认 | 每插件沙箱，Aide 无此能力 |

## 需要 AllInKit 团队确认 / 交付的三项

1. **R1–R5 的交付**：可注入后端 + builder + 默认实现 + 公开 API，`aik-host` 可 path 依赖。这是 Aide 侧 Phase 1 的前置。
2. **`window.aik` 协议**：插件 UI 在隔离 iframe 里通过 `window.aik.call(service, method, args)` 回调宿主。请确认 postMessage 消息格式 / Promise 语义 / 错误码，以及 `window.aik` 的引导脚本由插件 UI 自带还是由宿主在 iframe 加载时注入。Aide 倾向「宿主注入 bootstrap」以减少插件作者负担，但以 AllInKit 决定为准。
3. **后端 trait 方法签名**：clipboard / fs / notify / dialog 四个 trait 的方法集，Aide 注入实现需据此填对。

## 验收

- AllInKit 现有全量测试 + e2e 全绿（默认实现 behavior 不变）。
- 新增「注入 mock backend」单测通过，证明后端可换。
- `aik-host` 可作为 path 依赖被外部 Tauri 应用引入并注入自定义后端。

## 不在本需求书范围

- Aide 侧的实施（嵌入、面板、iframe 桥、安装流程等）由 Aide 侧自行设计与实现，不要求 AllInKit 参与。
- 不要求 AllInKit 评估或承诺工作量、文件数、排期——由 AllInKit 团队自行评估。