# docx 工具统一文档模型设计（read_docx / write_docx 一步到位改造）

日期：2026-08-13
状态：待评审
关联计划：`plans/2026-08-13-docx-unified-model.md`

## 1. 背景与问题

2026-08-13 用 read_docx / write_docx 规范化一份等保整改材料（加目录、修格式、重排截图），暴露的短板：

| # | 短板 | 实例 |
|---|------|------|
| 1 | read 输出 base64 灌 context，模型看不了图 | 60KB 文档里 6 张截图全转成 data URI |
| 2 | 截断不可感知，且截断点落在图片中间 | DOCX_MAX_CHARS=60000 拦腰截断，误判"只有 1 张图"（实际 6 张） |
| 3 | 格式信息转换失真 | 表格变 ASCII 艺术、缩进丢失、转义符残留，无法区分"原文问题"还是"转换丢失" |
| 4 | 无结构化输出 | 没有 headings 树/表格/图片/分节清单，只能全文硬读 |
| 5 | write 无 TOC 域/分页符/对齐/字号 | 被迫 jszip 手写 fldChar XML 手术（100+ 行脚本） |
| 6 | write 图片只认本地路径，拒绝 data URI | read 输出 base64、write 拒绝 base64——**read/write 不对称** |
| 7 | 图片宽度硬编码 480px | 930px 截图被压小，无参数可调 |
| 8 | 验证闭环断裂 | write 写进去的页眉页脚/TOC 域，read 读不回来，只能解压 XML 手工检查 |

**根因**：read 底层是 mammoth（只输出 markdown 文本流），write 底层是 docx 库（结构化 Document 模型）——**两套独立文档模型，天然不对称**。mammoth 对页眉页脚、域、分节、样式完全无感。

## 2. 目标（一步到位）

- **统一文档模型（IR）**：read/write 共享同一中间表示，对称是天然的
- **mammoth 退役**：read 不再依赖 mammoth，改自研 OOXML 解析器（控制子集范围）
- **write 原生能力**：TOC 域、分页符、页眉页脚、对齐/字号、data URI 图片、图片宽度
- **read 结构化输出**：structure 模式、元信息、图片策略参数、截断统计
- **验证闭环**：write 之后 read 能读回全部写进去的能力

## 3. 架构

```
                    ┌──────────────────────────────┐
                    │      DocxDocument (IR)       │
                    │  sections / blocks / runs    │
                    │  tables / images / fields    │
                    │  headers / footers / styles  │
                    └──────┬───────────────┬────────┘
              parse/       │               │       gen/
        (OOXML → IR)       │               │  (IR → OOXML)
        jszip + 自研 XML   │               │  docx 库（继续用）
                    ┌──────┴───┐     ┌─────┴──────┐
                    │  parse/  │     │   gen/     │
                    └──────────┘     └────────────┘
              md/toMarkdown (IR→md)   md/toModel (md→IR)
              structure.ts (IR→JSON)  （marked + 扩展语法）
```

### 3.1 关键决策

**D1：IR 是唯一真相。** read 和 write 都经过 IR。mammoth 退役（依赖移除）。

**D2：解析器自研，控制子集范围。** OOXML 完整规范太大，只解析模型需要的子集，未知元素跳过不报错：
- 段落/run：文本、加粗、斜体、删除线、下划线、字体、字号、颜色、高亮
- 表格：行、列、gridSpan 合并、列宽、单元格底纹
- 图片：drawing → rId → media 文件（字节 + 尺寸）
- 域：fldChar/instrText（TOC、PAGE、其他），含缓存结果
- 书签/超链接：bookmarkStart/End、hyperlink（anchor 内部 / external 外部）
- 分节：sectPr（页眉页脚引用、页码格式、起始页码、页面尺寸、首页不同/奇偶页）
- 页眉页脚：header/footer 部件（复用正文 block 解析）
- 样式：styles.xml 段落/字符样式，basedOn 继承链解析

**D3：生成器基于现有 gen.ts 改造。** docx 库继续用（生成 OOXML 成熟可靠），但 gen.ts 的输入从 marked tokens 改为 IR。marked 解析移到 md/toModel 层。现有 gen.ts 的 walker 逻辑大部分可平移（walkBlocks/walkInline → IR 遍历）。

**D4：markdown 扩展语法**（write 输入，全部在 md/toModel 阶段处理）：
- `[TOC]`（独立段落）→ TOC 域（`TOC \o "1-3" \h \z \u`，dirty=true）
- `\newpage`（行首）→ 分页符
- `::: header 文本` / `::: footer 文本` → 页眉页脚；`{page}` 占位符 → PAGE 域；`{page}/{numpages}` → 页码/总页数
- `::: center` / `::: right` / `::: justify`（段落前导）→ 段落对齐
- 图片：`![alt](path){width=600}` → 宽度参数；`![alt](data:image/png;base64,...)` → data URI 支持
- 分节语法（封面无页码、正文从 1 起）→ P2，本期不做

**D5：read 输出模式**（read_docx 加可选参数，默认行为兼容）：
- 默认：markdown 流（基于 IR 生成，格式干净）+ 元信息（段落/图片/表格/分节数、截断统计）
- `structure: true`：IR 的 JSON 视图（headings 树、表格/图片/分节/域清单、页眉页脚内容）
- `images: "placeholder" | "skip" | "base64"`：默认 placeholder（占位符 + 图片清单，不灌 base64）

**D6：兼容性。** MCP 工具参数向后兼容（read_docx 只加可选参数）；DOCX_INSTRUCTIONS 更新；现有测试全部保留改造。

## 4. IR 类型定义（model.ts）

```ts
interface DocxDocument {
  sections: Section[];
  styles: StyleMap;            // 样式 id → 定义（含 basedOn 解析结果）
  media: MediaFile[];          // 图片字节（按出现顺序去重）
}

interface Section {
  headers: HeaderFooter[];     // type: default | first | even
  footers: HeaderFooter[];
  pageSize?: { width: number; height: number };
  pageMargins?: { top: number; right: number; bottom: number; left: number };
  pageNumberFormat?: "decimal" | "upperRoman" | "lowerRoman" | "upperLetter" | "lowerLetter";
  startPageNumber?: number;
  titlePg?: boolean;           // 首页不同
  evenAndOddHeaders?: boolean;
  blocks: Block[];             // 正文
}

interface HeaderFooter { type: "default" | "first" | "even"; blocks: Block[] }

type Block =
  | { kind: "paragraph"; runs: Run[]; style?: string;
      align?: "left" | "center" | "right" | "justify";
      indent?: { left?: number; right?: number; hanging?: number };
      spacing?: { before?: number; after?: number; line?: number };
      pageBreakBefore?: boolean }
  | { kind: "table"; rows: TableRow[]; widths?: number[] }
  | { kind: "image"; mediaId: number; width: number; height: number; alt?: string }
  | { kind: "field"; type: "toc" | "page" | "numpages" | "other"; instr?: string; cached?: Block[] }
  | { kind: "pagebreak" }
  | { kind: "hr" }
  | { kind: "bookmark"; name: string; anchor?: boolean }  // anchor=true 是跳转目标

interface Run {
  text: string;
  bold?: boolean; italics?: boolean; strike?: boolean; underline?: boolean;
  font?: string; size?: number;      // 半磅
  color?: string; highlight?: string;
  link?: { href: string } | { anchor: string };
  break?: boolean;                   // 段内换行
}

interface TableRow { cells: TableCell[] }
interface TableCell { blocks: Block[]; gridSpan?: number; width?: number; shading?: string }
```

## 5. 模块组织（分层：组织文件在上，子实现在下）

```
src/docx/
  model.ts            # IR 类型定义（唯一真相）
  constants.ts        # DOCX_MAX_CHARS / DOCX_MAX_BYTES / DOCX_MAX_IMAGE_BYTES 等
  parse/              # OOXML → IR
    index.ts          # 门面：parseDocxToModel(buffer) → DocxDocument
    xml.ts            # 轻量 XML 遍历工具（命名空间感知，字符串/正则实现，不引第三方）
    styles.ts         # styles.xml 解析 + basedOn 继承链
    body.ts           # document.xml 解析（段落/表格/图片/域/书签/分节）
    headers.ts        # header/footer 部件解析
  gen/                # IR → OOXML
    index.ts          # 门面：modelToDocxBuffer(doc) → buffer
    body.ts           # IR blocks → document.xml（平移现有 gen.ts walker）
    headers.ts        # 页眉页脚 → header/footer XML + sectPr 引用 + Content_Types/rels 注册
    styles.ts         # 样式生成（TOC1/TOC2 等）
  md/                 # markdown ↔ IR
    toModel.ts        # markdown → IR（marked + 扩展语法）
    toMarkdown.ts     # IR → markdown（read 输出，格式干净）
  structure.ts        # IR → structure JSON（read structure 模式）
```

## 6. 分阶段实施

| 阶段 | 内容 | 产出 | 测试 |
|------|------|------|------|
| 1 | IR 定义 + 解析器 | model.ts、parse/（xml/styles/body/headers） | 构造 OOXML → IR 断言（沿用 jszip 内存构造范式） |
| 2 | 生成器改造 | gen/（body/headers/styles），gen.ts 的 marked 逻辑迁出 | IR → OOXML → 解析回 IR round-trip |
| 3 | markdown 层 + 扩展语法 | md/toModel、md/toMarkdown | markdown → docx → markdown round-trip；扩展语法逐项断言 |
| 4 | read 输出模式 + MCP 层 | structure.ts、docxTools.ts 改造、DOCX_INSTRUCTIONS | 工具层测试 + smoke-mcp 冒烟 |

## 7. 风险与对策

| 风险 | 对策 |
|------|------|
| OOXML 解析复杂度失控 | 只解析 D2 子集；未知元素跳过不报错；样式继承只解析 basedOn 一级链 |
| XML 解析不引第三方（避免 npm 网络依赖） | 自研轻量遍历：docx 的 XML 规范化（无 CDATA/复杂实体），字符串+正则够用；若遇坑再评估 fast-xml-parser |
| 现有行为回归 | 现有测试全保留改造；MCP 参数兼容；冒烟测试覆盖 |
| 图片字节内存 | 沿用 DOCX_MAX_IMAGE_BYTES 上限；media 按需惰性读取 |
| 域更新依赖 Word | TOC/PAGE 域一律 dirty=true，Word 打开自动更新；缓存条目兜底显示 |

## 8. 能力边界（未来 Word 需求的判断框架）

### 8.1 覆盖范围（本次提升后）

| 需求类型 | 场景 | 结论 |
|---|---|---|
| 创建 | 报告/材料/方案/纪要/说明书：标题层级、段落、列表、表格、代码块、图片、对齐、字号、分页 | ✅ |
| 原生能力 | 目录（TOC 域）、页眉页脚、页码域、书签、超链接 | ✅ |
| 整理 | 读回结构（headings 树/表格/图片/分节/域/页眉页脚）、元信息、格式规范、加目录加页眉页脚 | ✅ |
| 验证闭环 | write 后 read 能读回全部写进去的能力 | ✅ |

### 8.2 三档边界

**A 档：架构上可扩展，需加能力（未排期）**
- 脚注/尾注
- 交叉引用（REF 域）："如图 3-1 所示"
- 题注 + 图表自动编号（SEQ 域）+ 图目录
- 分栏
- 分节语法（封面无页码、目录页罗马数字、正文阿拉伯数字）——IR 已预留字段
- 首页不同/奇偶页页眉（IR 已预留 titlePg/evenAndOddHeaders）

**B 档：架构上很难做（markdown 表达力天花板）**
- 文本框/浮动对象定位
- 艺术字、竖排文字
- 公式（OMML，需 LaTeX→OMML 转换器）
- 复杂表格（vMerge 纵向合并、嵌套表格、单元格内复杂布局）
- 像素级版式控制

**C 档：不做**
- 宏（VBA）、表单域、内容控件
- 修订/批注
- 像素级视觉还原（模板/渲染引擎的职责）

### 8.3 判断线

"内容型"Word 需求（写材料、整理规范、加目录加页眉页脚）→ 工具覆盖；
"版式型"需求（复刻模板、复杂排版、公式）→ 需提前评估或走模板方案。

### 8.4 后续扩展方向：模板驱动（本期不做，IR 预留对接）

pandoc reference-doc 思路：用户提供模板 docx（页眉页脚、页面设置、样式主题由模板定义），生成时套用模板样式定义，markdown 只负责内容。封面版式、页面设置、字体主题等"markdown 表达不了"的东西由模板解决。StyleDef 已按样式 id 映射设计，具备对接空间。

## 9. 验收清单

- [x] read_docx：structure 模式、元信息（段落/图片/表格/分节数）、截断统计、images 三策略
- [x] write_docx：`[TOC]` 域、`\newpage` 分页、`::: header/footer`（含 `{page}`）、`::: center/right`、data URI 图片、`{width=}` 参数
- [x] round-trip：markdown → docx → markdown 内容保真（含表格/代码块/图片）
- [x] 验证闭环：write 生成的 TOC 域/页眉页脚，read structure 模式能读回
- [x] 现有测试全绿 + 新增测试全绿 + smoke-mcp 冒烟通过
- [x] mammoth 依赖移除
