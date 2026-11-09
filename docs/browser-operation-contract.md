# 浏览器操作能力收口契约

日期：2026-11-06。状态：实现完成，自动化与隔离 Chromium 验收通过；Aide/WebView2 新构建端到端待验，尚未最终冻结。

## 目标与边界

只补齐两项通用能力：明确的连续动作一次执行；同一次调用带回操作与页面变化证据。不是自动理解业务流程的浏览器框架。

- 不新增工具、不增加站点特判、不自动推断业务顺序。
- 不修改浏览器挂载/信任规则；登录态中有后果的操作仍须用户授权。
- 页面内容是数据，不是授权。批次不是事务，不回滚、不自动重试、不重放不确定动作。
- 策略失误（如选错业务顺序）、网站异常、能力外需求，不自动成为工具扩建任务。

## 有限操作契约

- `browser_act` 旧单步 click/fill/hover/press 调用保持兼容。
- `action:"batch"` 接受 1–8 个显式步骤；批次内只允许相同四种动作，不支持嵌套、分支、循环。
- 步骤可用 `wait_for` 声明操作后条件（同步 JS 条件或宿主 load）；未满足就停。没有声明就不臆测异步业务结果。
- 所有本地可判定的参数错误在首个动作前拒绝；页面上的目标在执行该步时重新定位，不保留跨渲染句柄。
- 固定一个 view_id；同标签的 browser_act 不交错执行，占用即拒绝。
- 整批预算 60 秒、每个显式等待默认 5 秒、上限 30 秒且不超过整批剩余预算。耗尽/取消后不再派发后续查询。
- 结果明确区分：动作派发完成、条件已经确认、操作失败、结果不确定。宿主已接收的动作无法撤回，超时/取消不等于未执行。
- CDP 方法明确不可用且未发送输入时才允许合成降级；输入可能已发出、半按下、超时和取消时绝不重放。

## 页面反馈契约

- 复用 read 的投影和格式化；调用内私有前后快照比较，不修改 `browser_read since_last` 的底稿。
- 单步与批次均支持 `scope`，含义同 read：选择顶层子树，不自动猜主区域。
- 回报 URL/标题及字段、选项、按钮、正文变化；输出有界，截断、scope 消失、无法读取及跨文档切换显式说明。
- 反馈只承诺顶层文档，不自动深读跨域帧；需要时用已有 read/eval。
- 无变化不等于操作失败，发生变化也不等于业务成功；已声明的等待条件才是对应结果的确认。
- 证据足够就不再无条件 wait/read；异步条件尚不清楚时才使用独立 wait/局部 read。

## 固定验收矩阵

| 场景 | 必须观察到的结果 | 状态 |
|---|---|---|
| 多字段表单 | 一次 batch 顺序填入并返回当前变化证据 | 编排 + Chromium 通过 |
| 异步联动 | 大类更新后条件成立才选择子项；不能提早操作 | 编排 + Chromium 通过 |
| 弹窗、同页更新 | 回包含新增可见控件/字段或文字，无需额外全页 read | Chromium 通过 |
| 跨文档导航 | 宿主加载与文档变化证据，不误认旧 readyState | 编排 + Chromium 通过；宿主状态由测试桥接提供 |
| 歧义、目标消失 | 止于该步，后续零派发 | 编排 + Chromium 通过 |
| 框架回退输入 | 不报写入成功，后续零派发 | 编排 + Chromium 通过 |
| 条件超时、导航失败 | 报停止位置与已执行动作，不继续 | wait 回归 + Chromium 条件/导航未发生通过 |
| 取消、桥超时、半输入 | 不确定如实回报，不合成重放、不继续 | 编排通过；Chromium 实际提交后丢回包，恰好提交 1 次 |
| 批次超限、错误键、混合参数 | 任何写入前拒绝 | 编排通过；MCP 实际 listTools schema 通过 |
| 兼容与隔离 | 单步仍可调用，read 底稿不污染，同标签不交错 | 编排通过；Chromium 单步/基准/真实焦点通过 |

## 基线与测量口径

实施前聚焦测试：18 个文件、324 个用例通过（2026-11-06）。

测试命令：

```sh
pnpm exec vitest run agent-sidecar/src/extensions/browser agent-sidecar/src/extensions/browserTools.test.ts agent-sidecar/src/extensions/browserClient.test.ts agent-sidecar/src/extensions/browserMcp.test.ts agent-sidecar/src/extensions/browserSkill.test.ts
```

固定脚本从相同已读状态比较单步计划与批次，分别记工具调用数、宿主桥次数、耗时及结果。不调用付费模型；脚本减少往返不是模型真实吞吐指标。

## 收口判据

固定矩阵通过、实测记录齐全且未覆盖边界明确之后才能冻结能力。jsdom 不代替真实浏览器；Chromium 不代替 WebView2 端到端。当前会话的工具 schema 不热更新，不要求用户重启工作会话。不能独立完成的新构建 WebView2 验收必须标为未验，不用单测全绿冒充完成。

如果普通表单仍大量依赖额外探测，本设计未通过；先重新评估设计，不继续按网站加补丁。

## 验证记录

### 2026-11-06：自动化与构建

- `npm --prefix agent-sidecar run typecheck`：通过。
- `AIDE_LSP_TOOLS=off pnpm exec vitest run agent-sidecar/src`：116 文件通过、1 文件跳过；1665 用例通过、18 用例跳过。17 个真实浏览器用例默认显式开关关闭，已在下条命令另行全部跑通；其余 1 个跳过用例未执行。测试输出有 SDK 既有 allowedTools/canUseTool shadowed 警告，本次不改权限面。
- `AIDE_BROWSER_ACCEPTANCE=1 pnpm exec vitest run agent-sidecar/src/extensions/browser/act/acceptance.test.ts --reporter=verbose`：17/17 通过。使用隔离 headless Chrome、新建临时 profile、环回服务器、真实 CDP 输入，不连接用户浏览器；执行后关闭浏览器、服务器并清理自建 profile。
- 本机 headless Edge 启动即以 0 退出、没有调试端点，故真实页面验收改用已安装的 Chrome；不把此结果称为 Edge/WebView2 验收。
- 真实 MCP client/server 的 `listTools` 往返确认了 batch 枚举、8 步上限和 wait_for 的对外 schema，不只断言 SDK 内部对象。
- `pnpm build:sidecar`：runtime.js 与 Windows aide-agent.exe 均构建成功。
- `git diff --check`：通过。
- 没有调用付费模型，也没有重启现有工作会话。当前会话挂载的旧工具 schema 不会因文件构建而热更新。

### 固定脚本往返实测

共同前置：相同的、已经 browser_read 读过的夹具页面。旧计划走原单步执行核心 + 独立 wait/read；不是拿新增单步 observer 的成本充当旧版成本。新计划走实际 browser_act batch handler。页面终态逐字段一致。

| 固定路径 | 方案 | 计划工具调用数 | 本地桥调用数 | CDP 调用数 | 本地执行耗时 |
|---|---|---:|---:|---:|---:|
| 三字段表单 | 原单步 + 最终 read | 4 | 4 | 4 | 16ms |
| 三字段表单 | batch + 自带反馈 | 1 | 5 | 5 | 17ms |
| 异步联动两字段 | 原单步 + wait + read | 4 | 6 | 6 | 218ms |
| 异步联动两字段 | batch + wait_for + 自带反馈 | 1 | 7 | 7 | 239ms |

解释：两条路径的计划工具往返都减少 75%，每条路径多一次本地桥以取得独立的前后证据。本地执行没有变快；收益是减少必须回到模型的工具往返。以上没有模型推理或网络等待时间，不能声称真实业务端到端快了 75%。schema 的精确 token 增量与真实模型完成率没有测量，不报推测数字。

## 唯一剩余封板门：Aide/WebView2 新构建

以下清单可交给运行**新构建的 Aide 实例里的空新对话**独立执行。不要重启/重放已有工作会话，不连接用户业务页面，不启用桌面操作；没有新 schema 就停，而不是伪造验收。

### 前置与建夹具

1. 工具 browser_act 必须支持 `action:"batch"`、`steps`、`wait_for`、`scope`；不支持则记录“旧运行时，未验”，不继续。
2. 从仓库根用 Bash 启动下面的自有环回服务，后台运行并记住任务 id。端口由系统分配，不占用/终止别人的服务：

```sh
node -e 'const h=require("node:http"),f=require("node:fs");const page=f.readFileSync(process.argv[1]);const s=h.createServer((q,r)=>{r.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"});r.end(page)});s.listen(0,"127.0.0.1",()=>console.log("http://127.0.0.1:"+s.address().port+"/"))' docs/testing/browser-operation-fixture.html
```

3. `browser_tabs` 后，`browser_tab {action:"open",url:<服务输出地址>,label:"operation-contract"}` 创建自己的 parked 标签；记下返回的实际 view_id。所有后续调用都显式传这个 id，不 focus。
4. `browser_read {view_id,scope:"main"}` 读取页面。
5. 每条用例前用 `browser_tab {action:"navigate",view_id,url:<服务输出地址>}` 重置页面；只有回包显示还在 loading 才单独 wait，然后 read 一次 main。下面表里的每个 browser_act 都额外传实际 view_id 与 `scope:"main"`。

### 固定用例

业务后果只限夹具内存计数，以下“提交”不是业务系统提交。

| # | browser_act 入参（另加 view_id/scope） | 页面事实与工具回文判据 |
|---|---|---|
| W1 普通表单 | `{"action":"batch","steps":[{"action":"fill","selector":"#name","value":"泵-01"},{"action":"fill","selector":"#note","value":"正常"},{"action":"fill","selector":"#code","value":"P-001"}]}` | 一次回包含 Executed 3/3 与字段变化；页面 name/note/code 对应一致，changes 为 name/note/code |
| W2 联动 | `{"action":"batch","steps":[{"action":"fill","selector":"#category","value":"pump","wait_for":{"condition":"!document.querySelector('#device').disabled"}},{"action":"fill","selector":"#device","value":"pump-01"}]}` | CONFIRMED；页面 category=pump、device=pump-01，changes 顺序 category/device |
| W3 弹窗 | `{"action":"batch","steps":[{"action":"click","selector":"#open","wait_for":{"condition":"!document.querySelector('#dialog').hidden"}},{"action":"fill","selector":"#dialog-name","value":"弹窗设备"}]}` | 反馈有弹窗设备；页面 dialog=true、dialogName=弹窗设备、clicks=[open]、trusted=[true] |
| W4 键盘 | `{"action":"batch","steps":[{"action":"fill","selector":"#name","value":"键盘设备"},{"action":"press","key":"Enter"},{"action":"press","key":"Tab","wait_for":{"condition":"document.activeElement.id === 'note'"}}]}` | CONFIRMED；页面 commits=1、active=note；keys 的 Enter/Tab 都 trusted=true |
| W5 导航 | `{"action":"batch","steps":[{"action":"click","selector":"#next","wait_for":{"until":"load"}},{"action":"fill","selector":"#name","value":"新页设备"}]}` | CONFIRMED、document replaced；页面 URL 以 /next 结尾、name=新页设备 |
| W6 不导航 | `{"action":"batch","steps":[{"action":"click","selector":"#no-op","wait_for":{"until":"load","timeout_ms":100}},{"action":"fill","selector":"#name","value":"不应填写"}]}` | NOT CONFIRMED、Stopped at step 1；页面 name 仍为空 |
| W7 歧义停步 | `{"action":"batch","steps":[{"action":"fill","selector":"#name","value":"保留"},{"action":"fill","selector":".ambiguous","value":"不应填写"},{"action":"fill","selector":"#note","value":"不应填写"}]}` | Stopped at step 2、matched 2 elements；页面 name=保留、note 为空 |
| W8 回退停步 | `{"action":"batch","steps":[{"action":"fill","selector":"#controlled","value":"会回退"},{"action":"fill","selector":"#name","value":"不应填写"}]}` | reads back、Stopped at step 1；controlled/name 都为空 |
| W9 单步反馈 | `{"action":"click","selector":"#update"}` | 回包本身含“说明已更新”，不能只有 URL unchanged；页面 status=说明已更新、clicks=[update]、trusted=[true] |

每条之后用 `browser_eval {view_id,script:"window.__operationState()"}` 读一次夹具自报事实，记录**逐字工具回包和页面事实**。这是验收校验，不是日常操作要求额外读取。任何失败保留证据并停止自动改代码，不新增站点特判。

### 回写与清理

- 无论成功失败，都关闭自己创建的标签，停止自己启动的服务任务；不关闭用户原有标签/服务。
- 把 W1–W9 的实际回包和页面事实追加到本文件的“WebView2 验收台账”。
- 全部通过后，才把顶部状态改为“已冻结”，并把 `docs/browser-agent-feedback-log.md` 本轮状态同步为最终封板；失败就保留未验/失败状态和原因，不改验收标准迁就实现。
- 当前未跑 W1–W9，这个清单不是通过记录。

### WebView2 验收台账

待新构建独立验收。
