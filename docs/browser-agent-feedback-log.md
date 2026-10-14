# aide-browser：agent 使用反馈与取舍记录

aide-browser 的工具面是靠「让 agent 真用一遍、再问它哪里别扭」一轮轮磨出来的。这份文件记每一轮：
**谁提了什么、代码现状是否属实、做 / 不做、为什么**。

最有用的是「不做」那一栏——同一条建议会被不同 agent 反复提出来，没有记录就会反复讨论。

## 怎么用

- 新一轮反馈：在「轮次」下**最上面**加一节，按下面的格式写。
- 每条建议先对代码核实再判（agent 的描述经常只对一半），「现状」栏写核实结果与文件位置。
- 实施后把状态改成「已做」并填提交号；改主意了就改状态并写原因，**不删旧结论**。
- 判断口径见文末「取舍原则」；新原则是从某一轮里长出来的，就补进去。

状态：`待做` · `已做 <提交>` · `不做` · `搁置`（有条件，写明条件）

---

## 轮次

### 2026-10-14 · 三个会话的使用调研

来源：三个真实任务会话结束时问「aide-browser 用起来怎么样、有什么建议」。任务分别是
SPA 里查配置并抄值、多页签表单验收、图片上传链路与提问卡验收。共 14 条，去重后如下。

**本轮状态：「做」与「顺手做」共 8 条已全部实施（2026-10-14），单测与 jsdom 测试通过，提交 `aed7125e`；尚未在真机 WebView2 上走查。工具面固定成本约 +75 token。**

#### 做

| # | 建议 | 现状（已核） | 做法 | 状态 |
|---|---|---|---|---|
| 1 | `browser_network` 请求体被整段截断，关键字段恰在大字段后面（8.6KB base64 挤掉了其后的 `uploadedUrl`） | 属实。`browser/recorder.ts`：请求体从头留 `RECORDER_REQ_CAP`=600 字符、响应体留 `RECORDER_TEXT_CAP`=300，其余砍掉 | 在已有的 `redactJson` 遍历里把超长字符串值折成 `<8682 chars>`，之后再做整体截断。阈值：值超过 200 字符折成「前 40 字符…`<N chars>`」；urlencoded 与 FormData 的值同样折 | 已做 `aed7125e` |
| 2 | 表单字段认不出标签：输入框旁边明明写着名字，回的是 `(no label found)` | 属实。`browser/fieldLabel.ts` 兜底链：aria-label → `label[for]` → 包裹的 `<label>` → 表格相邻格 → placeholder，没有「相邻文本」一级 | 加一级：向上找「只含这一个字段」的容器，取字段之前的文本。read 与 fill 共用这份判定，两边同时受益。两道闸防认错：容器里出现第二个字段就停、文本超过 40 字符就停；标题（h1–h6）不算；勾选类控件前面没有时看后面。排在 placeholder 之前 | 已做 `aed7125e` |
| 3 | act → wait → read 三步合并：一次点击要三个来回才能确认结果 | 属实。`browser/act.ts` 的 `performClick` 只回 `Clicked … at (x,y)` | 只做便宜的一半：点击前后各读一次 URL 与标题，回报「URL a → b」或「未变」。代价：每次点击多等约 250ms、多一发探针。地址没变时说「URL unchanged」并指向 `since_last`，不说成没反应；点完读不到页面（正在换文档）如实说 | 已做 `aed7125e` |
| 4 | `navigate` 之后要不要再 `wait until:"load"` 说不清 | `browser/tab.ts` 的 `performNavigate` 已等 `NAV_SETTLE_MS` 再读 `location.href` | 同一次 eval 顺带读 `document.readyState` 并回报（complete 时明说不用再 wait） | 已做 `aed7125e` |
| 5 | `browser_read` 输出重复、噪音大（**三个会话都提了**：外壳每次重印、长列表全量铺开、Outline / Tables / Raw text 重复） | 部分属实。正文已默认收起、同形字段已折叠（`c23d6ba8`）；但可点元素不折叠，也没法只读页面的一块 | `browser_read` 加 `scope`（CSS 选择器，只投影该子树）+ 可点元素的同名连续项折叠（连续 4 个起）。`scope` 命中多个取第一个并报数；没命中或选择器非法如实失败、不退回整页；`since_last` 的底稿按 scope 分开记；帧内不套用 | 已做 `aed7125e` |

实施顺序：1 → 2 → 4 → 3 → 5。前两条是「证据拿不到、只能靠猜」的正确性问题，后面才是省往返与省 token。

#### 顺手做

| 建议 | 现状（已核） | 做法 | 状态 |
|---|---|---|---|
| `browser_eval` 的地位在说明里抬一档 | 描述只说它是 escape hatch，容易被读成「不该用的后门」 | 加一句：框架状态（Vue / React store）不在 DOM 里，只能用 eval 读 | 已做 `aed7125e` |
| 禁用 / 隐藏项缺原因 | `disabled` 已标 DISABLED；缺 `aria-disabled`，且 `include_hidden` 时不标哪些是隐藏的 | 补这两个标注（`aria-disabled` 计入 DISABLED；`include_hidden` 列出的隐藏项标 HIDDEN），不做原因分类 | 已做 `aed7125e` |
| 导航 displayed 视图会改掉用户眼前的页面，应提示一句 | 已核：navigate 回包的 `view` 是 `BrowserViewDto`，带 `displayed` | 目标视图 displayed 时在结果末尾加一行 NOTE，指向 `open` 开 parked 视图 | 已做 `aed7125e` |

#### 不做

| 建议 | 不做的理由 |
|---|---|
| 页面正文里的密钥默认打码 + 显式 reveal | 在自由文本里猜「什么是密钥」必然误伤，提这条的 agent 自己的任务就是抄 key。密码框与请求体凭据字段已遮，这条线够用 |
| 新增 `browser_find {pattern}` 工具 | 每个工具的 schema 每个会话都付 token；有了 `scope` 需求小很多。真要做，应是 `browser_read` 的一个参数 |
| `since_last` 增加「面板切换 / 跨导航」专门模式 | 整块换掉时 diff 等于全量就是事实；`scope` 已覆盖该场景 |
| `sections` / `raw_text: false` 取舍开关 | 与 `scope` 解决同一个问题，不加第二个旋钮 |
| 自动识别主内容区、排除 nav / footer | 启发式，猜错即静默丢内容，违背「如实」纪律 |
| `<select>` 按「当前可见的选项文本集合」定位 | `index` 能用，结果也如实报了 `3 elements matched; used index 1`；场景太少 |

#### 被点名「用得顺」的（改动时别破坏）

- `browser_act` 拒绝点「文本在但不像可点击」的元素并给候选 selector——拒绝本身被当成了证据。
- parked 视图全程后台跑、不打扰用户；`focus` 才显式推到前台。
- `browser_wait` 超时文案带下一步（「同文档导航不会出现在这里」）。
- `browser_network` 如实说明 recorder 是本次才装的、需 reload 才有完整抓取；`open` 的视图生来就装好。
- `browser_act` 如实报告用的是真实 CDP 输入还是合成回退。
- `browser_read` 的 `since_last`、`browser_tabs` 的 displayed / parked 区分。

---

### 更早的轮次（据提交历史补记，原始反馈未留档）

以下只有「做了什么」，当时的建议全集与否决项已不可考。

| 日期 | 做了什么 | 提交 |
|---|---|---|
| 2026-10-12 | 使用说明与工具描述瘦身，约 6.0k → 3.7k token | `6a4d793c` |
| 2026-10-07 | `browser_read` 瘦身：同形字段折叠、正文默认收起、`since_last` 差异 | `c23d6ba8` |
| 2026-10-07 | network 记录请求体（凭据字段脱敏） | `e216ffab` |
| 2026-10-07 | fill 按字段名找输入框，找不到时列字段候选 | `4649670c` |
| 2026-10-07 | eval 块作用域可重复声明、字符串结果不再二次转义 | `0db9229f` |
| 2026-09-29 | 走查四修：press 真按键、selector 歧义不猜、fill 读回校验、open 时 arm recorder | `4db3609f` |
| 2026-09-23 | navigate 回报观测到的落点而非请求值；同文档导航明说 | `76a3e7d6` |
| 2026-09-23 | `browser_wait` 带出文档身份、耗时改为实测 | `5b94192d` |
| 2026-09-23 | Raw text 走 innerText，与 skeleton 同一份可见性 | `f03db68c` |
| 2026-09-23 | act 文本匹配容错 CJK 空白、命中歧义如实报数 | `99bd24ea` |
| 2026-09-23 | 元素级截图 | `fb617ebb` |
| 2026-09-23 | 新增 `browser_network` / `browser_console` 与页面内 recorder | `6f6fefde` `6a7cfcb5` `375b8c7a` |
| 2026-09-22 | 一个「可点击」判据同时喂 read 与 act；「找不到」三分支；read 默认只列可见 | `f0104d22` |

---

## 取舍原则

从历轮决定里归纳出来的，判新建议时先过一遍：

1. **如实优先于省事**：截断、降级、回退、猜测都要说出来；会「静默丢内容」的启发式不做。
2. **工具面不出现站点名词**：换一个站点，`browserTools.ts` 一行不动。站点知识放 skill reference。
3. **新工具有常驻成本**：schema 每个会话都付 token。能做成已有工具的参数就不新增工具。
4. **同一个问题只给一个旋钮**：几条建议指向同一处痛点时，选一个能同时覆盖的参数。
5. **多个会话独立提到同一处，才算强信号**；单个会话的单次别扭先看是不是场景特例。
6. **read 说得出的，act 就得做得到**：可发现性与可操作性共用同一份判定（`clickable.ts` / `fieldLabel.ts`）。
7. **用户的凭据不进模型上下文**，但只遮认得准的（密码框、凭据字段名），不在自由文本里猜。
