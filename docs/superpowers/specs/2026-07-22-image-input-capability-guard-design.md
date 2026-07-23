# 图片输入能力防护设计

**日期：** 2026-07-22
**状态：** 已实现并验证（2026-07-23，见文末「实现修正记录」）

## 背景与问题

当不支持视觉输入的模型（已确认案例：`glm-5.2`）通过 Claude Agent SDK 的 `Read` 工具读取图片时，SDK 会将图片作为视觉内容带入后续模型请求。上游返回 `400 this model does not support image input`。

当前实现存在两处缺口：

1. `agent-sidecar/src/permissions.ts` 的 `canUseTool` 许可路径对 `Read` 不区分文本和图片，图片读取可直接执行。
2. Provider 模型列表仅保存模型 ID，不提供可跨 Provider 获取的视觉能力元数据。400 会作为 `fatal:false` 错误显示在前端，但 SDK 会话仍会恢复同一个 JSONL 历史；失败的图片相关输入保留在历史中，后续纯文本消息也可能再次触发同一 400，表现为会话不可继续。

直接粘贴图片也会从前端组装视觉输入，存在同样的污染风险。

## 目标

- Aide 自动识别当前 Provider + 当前模型是否支持图片输入，不要求用户手工标记模型能力。
- 在真实会话执行图片 `Read` 或发送粘贴图片前完成能力判断，绝不让不支持视觉的模型收到真实图片字节。
- 探测失败、认证失败或网络失败不得误判为“不支持图片”。
- 文本 `Read`、普通权限确认、支持视觉模型的图片工作流保持不变。
- 不向前端/Rust 核心 IPC 引入 Claude 或厂商专属字段；SDK 专用探测仅存在于 `agent-sidecar/`。

## 非目标

- 不自动修改已被旧版本图片输入污染的 JSONL 会话历史。失败后自动截断历史无法可靠识别安全回退点，可能丢失用户内容。
- 不维护模型或厂商名称黑名单。
- 不对 Provider 设置增加人工能力标记字段。
- 不读取用户的图片文件作为排查或探测材料。

## 方案比较

### 方案 A：人工配置模型能力

由用户在 Provider 设置中标记模型是否支持图片。

- 优点：无需探测请求。
- 缺点：新增、升级或自定义模型均需要人工维护，容易遗漏。

### 方案 B：自动隔离预检（采用）

首次需要图片输入时，对当前连接和模型执行一个独立、不持久化的微小视觉能力请求，并缓存结果。

- 优点：对 OpenAI 兼容网关、GLM 等没有统一能力元数据的 Provider 自动工作；不会污染真实会话。
- 缺点：每个新模型在首次使用图片时有一次极小额外请求。

### 方案 C：收到 400 后修复会话

先让真实会话失败，再删除坏历史或重建会话。

- 优点：不增加探测请求。
- 缺点：失败已发生；SDK JSONL 的精确回退点不可靠，无法保证不丢数据或不再复发。

## 架构

### 1. Sidecar 专属能力模块

在 `agent-sidecar/src/` 新增独立的图片输入能力模块，职责为：

- 识别 `Read` 目标路径是否为常见图片文件（扩展名大小写不敏感）。
- 为 `(connection fingerprint, resolved model id)` 管理 `unknown | supported | unsupported` 状态。
- 首次未知状态时发起隔离探测，复用当前 Provider 的环境变量和当前模型。
- 只将明确匹配“模型不支持图片输入”的 HTTP 400 归类为 `unsupported`；成功结果归类为 `supported`；认证、网络、限流和其他 4xx/5xx 错误保持 `unknown`，不写缓存。

缓存仅在 Agent Runtime 进程生命周期内存在。Runtime 重启后可重新探测；不将短期探测结论写入 Provider 配置，避免过期或错误的能力结论长期生效。

### 2. 隔离探测

探测使用独立的 Agent SDK `query()`：

- 输入使用内置的极小测试图片，不读取、不上传用户本地图片文件。
- 不复用用户会话，不传 `resume`，并设置 `persistSession: false`。
- 禁用工具，限制为极短的确认任务。
- 成功时仅记录支持状态；明确视觉不支持的 400 时记录不支持状态。

探测的会话和结果永远不写入正在对话的 SDK JSONL。

> **实现修正（2026-07-23）：** 原设计假设 400 以 `type:"result"`、`is_error:true`、`api_error_status:400` 的消息出现，`classifyImageInputResult` 据此判定。但真实 SDK 行为（glm-5.2 会话 JSONL 实锤）是：CLI 把 `400 this model does not support image input` 包成一条 `model:"<synthetic>"` 的**合成 `assistant` 文本消息**，其后**没有 `result` 条目**；部分网关还会让 CLI 非零退出、SDK 直接抛异常（文本形如 `接口返回错误（HTTP 400） — API Error: 400 …`）。原分类只认 `result`，两条真实路径都被 `catch { return null }` 吞掉 → probe 恒为 `unknown` → 守卫全部放行 → 400 照样冒到用户。修正：`probeImageInput` 增补 `extractMessageText`，对合成 `assistant` 消息的 content 文本和 `catch` 捕获的异常文本同样用 `IMAGE_UNSUPPORTED_400`（`API Error: 400`/`HTTP 400` + `this model does not support image input`）匹配，命中即返回 `false`；其它异常仍返回 `null`。详见 `agent-sidecar/src/imageInputCapability.ts`。

### 3. 工具调用防线

`SessionWorker` 在既有 `canUseTool` 链路中增加前置守卫：

1. 非 `Read` 或非图片路径：直接委托现有 `PermissionManager`，语义不变。
2. 图片路径且缓存为 `supported`：直接委托现有 `PermissionManager`。
3. 图片路径且缓存为 `unsupported`：返回 SDK 的拒绝结果，不执行 `Read`。
4. 图片路径且能力未知：完成隔离探测后按支持/不支持分支处理；探测仍未知时维持现有许可路径，不把临时故障误判为模型限制。

拒绝原因必须是可供模型行动的文本，例如：当前模型不支持图片输入，不能读取该图片；可改为读取 OCR/文本描述、跳过该文件，或切换到支持视觉的模型。

该防线在 SDK 产生图片工具结果之前阻止调用，因此不会污染真实会话历史。

### 4. 直接粘贴图片防线

前端发送前复用 Sidecar 的能力判断，而不是在 Vue/Rust 中复制 Provider 专属探测逻辑：

- 发送命令带有图片附件时，Sidecar 在将用户消息压入 SDK 队列前先确认能力。
- 已知不支持时，Sidecar 不压入含图片的用户消息，并以可恢复错误/通知反馈原因。
- 前端保留文本输入，不创建含图片的用户气泡；以现有主题化 Toast 告知用户。
- 支持和未知但探测失败的非确定场景维持当前发送行为，避免凭空拦截。

核心 `SidecarCommand` 如需携带图片能力相关的状态，只能使用所有未来 Provider 都能理解的通用语义字段；不得出现 Claude、GLM 或 Anthropic 专属字段。

## 已污染旧会话的处理

本次不自动截断 JSONL。用户会收到明确说明：该历史会话已包含不兼容的图片输入；请新建会话，或用已有“会话回退”能力回到出错前一轮。新机制保证新发生的图片读取不会再污染会话。

## 图片入口路径核对（2026-07-23）

确认所有把图片字节送进模型的路径均被覆盖，无需为 `@path` 引用额外加守卫：

1. **粘贴/拖拽附件** → `SidecarCommand.send.images` → `SessionWorker.handleSend` 的 `guardImageInput` + 前端 `probeImageInput` 预检。
2. **`Read` 图片路径** → `makeCanUseToolCallback` 前置守卫。
3. **`@<图片路径>` 引用** → 前端 `resolveFileMentions` 用 `read_file_content`（`fs::read_to_string`）读取，二进制图片必以「stream did not contain valid UTF-8」失败，`resolveFileMentions` catch 后保留字面量 `@path` 文本，**不会内联成图片块**；随后要么退化为 `Read`（落入路径 2），要么仅作为文本提示。故 `@` 引用不构成独立缺口。

## 错误与状态

- 探测确认不支持：图片 `Read` 转为工具级拒绝，模型可继续本轮并调整策略；不发出导致会话错误的真实视觉请求。
- 直接粘贴图片确认不支持：拒绝发送图片并显示 Toast，不创建消息，不切换会话至 running。
- 探测认证/网络/限流失败：不缓存不支持，沿用既有错误处理，不以能力不支持名义提示。
- 已有的普通 `result` 错误映射、`fatal:false` 事件和前端 `waiting + warning` 语义保持不变。

## 测试与验收

### Sidecar 单元测试

- 图片路径识别：`.png`、`.jpeg`、`.gif`、`.webp`、大写扩展名和非图片路径。
- 能力缓存：同一连接/模型只探测一次；不同模型或不同连接独立缓存。
- 探测分类：成功 → supported；精确视觉不支持 400 → unsupported；认证、网络、429、其他 400/500 → unknown 且不缓存。
- `canUseTool` 守卫：unsupported 时图片 `Read` 被拒绝且不触发现有权限弹窗；文本 `Read` 与支持图片的 `Read` 仍进入既有 `PermissionManager`。

### 会话工作流测试

- 模拟 `glm-5.2` 视觉不支持：图片 `Read` 被 SDK 拒绝，真实主 query 不接收图片结果，后续纯文本消息可继续处理。
- 模拟支持视觉的模型：图片 `Read` 的调用和权限交互与修复前一致。
- 粘贴图片：不支持时不写入用户消息、不发送含 `images` 的 SDK 消息，文本保持在输入框；支持时正常发送。

### 手动验收

1. 选择 `glm-5.2`，让 Agent 尝试读取图片文件：显示可理解的工具错误，而不是 `API Error: 400 this model does not support image input`。
2. 随后继续发送纯文本：同一会话能正常回复。
3. 选择视觉模型重复操作：图片读取正常。
4. 在不支持模型粘贴图片：出现主题化 Toast，图片不进入消息历史。
