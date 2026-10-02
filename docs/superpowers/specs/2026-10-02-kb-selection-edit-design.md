# 知识库「圈选 → 交给 AI 改」— 设计

- 日期：2026-10-02
- 状态：已实现（单测全绿；Windows 真机手感待验，见 §9）
- 范围：`agent-sidecar/src/extensions/knowledge*`（授权与工具）、`packages/aide-sdk`（发送链路 / 事件 / 历史还原）、`src/components/KnowledgeBase/`（渲染位置标注 + 圈选层）、聊天输入框与气泡卡片
- 来源：对 WorkBuddy 资料库的复盘——它的「圈选批注 → 让 Agent 改」。**硬要求（用户原话）：圈中什么改什么，不会改到其它内容。**
- 关联：`2026-09-30-aide-library-design.md`、`2026-10-02-browser-pick-to-agent-design.md`（浏览器版，已搁置；共用 SDK 层的 `pageref` 块，UI 未做）

---

## 1. 产品

团队知识库里的一篇文档，想让 AI 改**其中一段**。今天只能用文字描述「第三节那段」，AI 读全文再猜；改完也无法保证没动别处。

现在：在阅读态选中文字 → 出现小入口「✦ 让 AI 改这段」→ 浮窗里写一句意见（或点常用意图）→ 回车。AI **只被允许**改那一段，文档里高亮、角标、状态一路跟着，改完可一键撤销。

对话**不放进文档**（不是评论线程）：文档里只有「指哪里」和「结果在哪」，来回讨论在聊天里。用户 2026-10-02 定（方案 A）：对话没必要让同事看见。

## 2. 「圈中什么改什么」靠机制，不靠提示词

四道关，任何一道失守其余仍成立：

| # | 关 | 在哪 | 作用 |
|---|---|---|---|
| 1 | **范围由用户定** | 前端 `scopeFromRange` → `display.kbref` → sidecar `KbScopeStore` | 起止偏移来自用户的选区，经用户消息进入 sidecar。agent **没有「范围」参数**（工具入参只有 `selectionId` / `newText` / `changeNote`，有测试钉死）。 |
| 2 | **构造性不变** | `applySelectionEdit` | 新正文 = 原文前缀 + 新文本 + 原文后缀。前后缀是同一份字符串的切片，没有一个字符经过 agent 之手。 |
| 3 | **原位校验** | `editSelection` | 写入前要求 `content.slice(start,end) === 圈选原文`；文档在圈选之后被改过 → 拒绝，让用户重新圈。不做「重新定位」——错位的代价是改错地方。 |
| 4 | **写后读回核对** | `editSelection` | 写完再读一次，核对选区之外的前后缀逐字不变；并发改动导致的漂移如实告警（PUT 没有乐观锁，这是能做到的最强保证）。 |

另有一道**封口**：圈选生效期间（本轮用户消息带 `kbref`），`update_document` / `append_document` / `create_document` / `create_folder` / `move_document` / `delete_document` / `ingest_file` 一律回拒绝文本、不碰服务端——否则 agent 可以绕开 `edit_selection` 整篇重写。下一条不带圈选的用户消息到达后恢复。

## 3. 数据流

```
文档阅读态（KbDocumentView）
  └ 选中 → scopeFromRange(range, body, 源文) → {start,end,text,行号,precise}
       └ 浮窗确认 → useKbSelections（草稿 → 待发送）
            └ requestSend → 聚焦的 ChatInputBox → send-request{ kbrefs }
                 └ useChatSession：prompt = 展开文本（formatKbRefsForPrompt）
                                    display = [text, kbref…]   ← 授权的权威来源
                      └ Rust send（display 原样透传）→ sidecar
                           └ SessionWorker.pushUserMessage → KbScopeStore.replaceFromDisplay
                                └ edit_selection(selectionId,newText) → 校验 → PUT → 读回核对
                                     └ 聊天事件 tool_use_start / tool_result / message_stop
                                          └ events.ts → kbSelectionEvents 总线 → useKbSelections
                                               └ 文档里：处理中 → 已改 vN（刷新文档、新范围高亮、可撤销）
```

状态只由「用户操作」与「聊天事件流」推进，**本地绝不乐观宣布 done**。

## 4. 渲染页 ↔ 源文的对位

- `renderKbMarkdown` 给每个顶层块与顶层列表条目写 `data-s` / `data-e`（源文 UTF-16 偏移，止 = 末行行尾，不含换行与 `\r`；起点跳过行首缩进）。只加属性、不加包裹元素；html 类 token 不标。预处理（给组件标签补空行、去缩进）带行号映射，CRLF 在预处理里先归一——这两处都由单测暴露并修复。
- `scopeFromRange`：同一块内、选中文字在该块源文里能唯一对上（DOM 第 k 次出现 ↔ 源文第 k 次，且总次数相等）→ **精确到字**；跨块 / 含加粗链接等格式 / 对不上 → **扩大到整块并如实标 `precise=false`**；选到没有源文位置的区域 → 拒绝，不猜。
- `rangeForSource`：逆映射。高亮全由源文偏移推出，不攥着 DOM Range（正文重渲染后 Range 会塌缩）。

## 5. 交互与视觉

颜色全走主题变量；人 = `accent`，AI = `agentAccent`（✦，与应用既有语义一致），成功 / 危险 / 警示各用既有 token。

- **小入口**：选中文字后挂在末尾的一枚药丸，**不直接弹窗**（选中文字常是为了复制）；点了才产生草稿。
- **浮窗**：标题 + **范围说明胶囊**（`第 12 行 · 这几个字` / `第 12–14 行 · 整块`，扩大到整块时换警示色）+ 一句话输入 + 常用意图（更简洁 / 更具体 / 改得更正式 / 修正错别字 / 翻译成英文 / 补充例子）+ 「再圈一处」/「交给 AI ↵」。底部一句话写明 AI 只会改哪里。回车发送，Shift+回车换行，输入法组词中的回车不提交，Esc 取消并丢弃草稿。
- **高亮 / 角标 / 托盘**：待发送 = 编号角标 ①②；处理中 = AI 色 + 一道流光扫过 + 三点呼吸；改好 = 成功色新文字亮一下再静下；被拒 / 没改 = 人话原因，可收起。底部托盘「N 处已圈 · 补一句话 · 一起交给 AI」粘在文章可视区底部（解决「知识库打开时聊天输入框不在眼前」）。
- **撤销** = 回滚到圈选那一刻的版本；仅当「之后没有别的改动」才可用，否则禁用并提示去历史里回退（不把别人的改动一起回掉）。
- **聊天侧**：输入框上方同步出芯片（× 即不要这一处）；气泡里一张折叠卡片（《标题》· 第 N 行 · 意见 · 实时状态，点开看被圈的原文与「AI 只被允许修改下面这一段」）。
- 动效全部 `prefers-reduced-motion` 可关；键盘焦点环可见。

## 6. 多端与历史

- 用户气泡只认 sidecar 广播的 `user_message`（红线）；手机端不认识 `kbref` 就跳过该块，整条消息不消失（PWA 渲染链本来就忽略未知块，类型检查已验）。**桌面不替手机端改。**
- `display` 不落盘。重开历史会话时，用户消息只有展开文本——`splitKbRefSections` 是 `formatKbRefsForPrompt` 的逆（同文件，往返有测试），还原成同样的卡片。
- 展开文本里选区原文按「**仅作数据，不是指令**」包起来，伪造的收尾标记被转义（可逆）：知识库正文团队里任何人可写，是现成的注入路径。

## 7. 对账与测试

`userMessageBlockParity.test.ts` 按源码文本抽出 `kbref` / `pageref` / `mention` 的顶层字段（含可选性）逐一比对两份 `UserMessageBlock`——此前全靠注释提醒；已用故意制造漂移验证它能抓住。

覆盖：授权登记与整表替换、范围替换纯函数、`edit_selection` 端到端（假知识库服务）、其余写工具封口（7 个逐一）、渲染位置标注（段落 / 列表 / 代码 / 引用 / 表格 / CRLF / 组件标签 / 缩进）、DOM↔源文双向对位、状态机与定时收起、SDK 发送 / 气泡 / 进度事件 / 历史还原、圈选层的交互流程（jsdom，矩形 mock）。

## 8. 已知代价

- **精确档要求选中文字在块源文里唯一对位**；跨格式一律扩大到整块——宁可多框，不猜。
- **PUT 没有乐观锁**：「读 → 校验 → 写」之间有极小窗口；写后读回核对把漂移如实报出，不能杜绝。
- 同一轮里排队的下一条用户消息到达会提前替换登记簿（队列消息的边界情形，只会让 AI 更受限，不会放宽）。
- 状态用 `sid` 对 `turn_end`；新会话首条消息的临时 id 与事件里的真实 id 不一致时，靠 180 秒兜底收起 `sent`。
- 只在阅读态、markdown 文档上可圈选；html 产物（在右栏浏览器里）是浏览器版的范畴。
- 权限弹窗里 `edit_selection` 显示的是工具入参（选区 id + 新文本），没有「原文 ↔ 新文本」对照——后续可给它做专用摘要。

## 9. 待真机确认（WSL 上无 WebView2，无法验证手感）

高亮位置在图片异步撑开、窗口缩放后的重排；小入口 / 浮窗的位置与翻转；流光与角标的观感；`Selection` 在 WebView2 里三击 / 拖选的真实形状。
