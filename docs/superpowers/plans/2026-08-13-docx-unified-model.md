# docx 工具统一文档模型实施计划

日期：2026-08-13
设计：`specs/2026-08-13-docx-unified-model-design.md`
状态：待评审

## 阶段 1：IR 定义 + 解析器（OOXML → IR）

**目标**：`parseDocxToModel(buffer) → DocxDocument`，mammoth 退役的解析替代。

1. `src/docx/model.ts` — IR 类型定义（按 spec §4）
2. `src/docx/constants.ts` — 常量迁移（DOCX_MAX_CHARS/BYTES/IMAGE_BYTES 从 parse.ts 迁入）
3. `src/docx/parse/xml.ts` — 轻量 XML 遍历：
   - `findChildren(xml, tag)` / `findFirst(xml, tag)` / `attr(xml, name)` / `text(xml)`
   - 命名空间感知（w: 前缀剥离），字符串+正则实现
4. `src/docx/parse/styles.ts` — styles.xml 解析：
   - 段落样式（pStyle）/ 字符样式（rStyle）定义表
   - basedOn 继承链解析（一级链，防环）
5. `src/docx/parse/body.ts` — document.xml 解析：
   - 段落（pPr：align/indent/spacing/pageBreakBefore；runs：rPr 全字段）
   - 表格（tblGrid 列宽、tr、tc：gridSpan/width/shading）
   - 图片（drawing → rId → rels → media 字节 + 尺寸）
   - 域（fldChar begin/instrText/separate/end，缓存结果块）
   - 书签（bookmarkStart/End）、超链接（hyperlink anchor/href）
   - 分节（sectPr：headerReference/footerReference/pgNumType/pgSz/pgMar/titlePg/evenAndOddHeaders）
6. `src/docx/parse/headers.ts` — header/footer 部件解析（复用 body 的 block 解析）
7. `src/docx/parse/index.ts` — 门面：jszip 解包 → 各部件解析 → DocxDocument；错误分类沿用 classifyDocxError
8. 测试 `src/docx/parse/model.test.ts`：jszip 内存构造 OOXML（沿用现有 makeDocx 范式，扩展 header/footer/表格/域/图片部件）→ IR 断言

**验收**：构造含段落/表格/图片/域/分节/页眉页脚的 OOXML，IR 断言全过；现有 parse.test.ts 的 classifyDocxError/resolveDocxPath 保留。

## 阶段 2：生成器改造（IR → OOXML）

**目标**：`modelToDocxBuffer(doc) → buffer`，现有 gen.ts 的 walker 平移为 IR 遍历。

1. `src/docx/gen/body.ts` — IR blocks → docx 库节点（平移现有 walkBlocks/walkInline）：
   - paragraph（align/indent/spacing/pageBreakBefore 映射）
   - table（gridSpan/width/shading）
   - image（mediaId → media 字节，宽度参数）
   - field（TOC/PAGE 域：fldChar begin/instrText/separate/缓存/end，dirty=true）
   - pagebreak / hr / bookmark / hyperlink
2. `src/docx/gen/headers.ts` — 页眉页脚：
   - header/footer 部件生成（复用 body 的 block → 节点）
   - sectPr 引用 + [Content_Types].xml 注册 + document.xml.rels 关系
3. `src/docx/gen/styles.ts` — 样式生成（TOC1/TOC2 等段落样式定义）
4. `src/docx/gen/index.ts` — 门面：Document 组装（sections 多节、numbering、styles）
5. 测试 `src/docx/gen/model.test.ts`：IR → OOXML → parseDocxToModel 回读断言（round-trip）

**验收**：IR round-trip 全过；现有 gen.test.ts 的 markdown 用例迁到阶段 3 后改造。

## 阶段 3：markdown 层 + 扩展语法

**目标**：`mdToModel(markdown) → DocxDocument`、`modelToMarkdown(doc) → string`。

1. `src/docx/md/toModel.ts` — marked lexer → IR（平移现有 walkBlocks/walkInline 逻辑）+ 扩展语法：
   - `[TOC]` 独立段落 → TOC 域
   - `\newpage` 行首 → pagebreak
   - `::: header/footer 文本` → 页眉页脚（`{page}` → PAGE 域、`{numpages}` → NUMPAGES 域）
   - `::: center/right/justify` 段落前导 → align
   - 图片 `{width=600}` 参数、data URI 解码
2. `src/docx/md/toMarkdown.ts` — IR → markdown（read 输出）：
   - 段落/表格/代码块/图片（placeholder 或 base64 按策略）
   - 标题（heading 样式 → # 层级）
   - 域（TOC → `[TOC]` 标记 + 缓存条目；PAGE → `{page}`）
   - 页眉页脚 → `::: header/footer` 块（structure 模式用）
3. 测试 `src/docx/md/md.test.ts`：
   - 现有 gen.test.ts 用例迁移（markdown → docx 行为不变）
   - 扩展语法逐项断言（TOC 域 XML、分页符、页眉页脚、对齐、data URI 图片、宽度）
   - round-trip：markdown → docx → markdown 内容保真

**验收**：现有 markdown 渲染行为零回归；扩展语法全过；round-trip 保真。

## 阶段 4：read 输出模式 + MCP 层

**目标**：read_docx 加 structure/images 参数，write_docx 走新链路，DOCX_INSTRUCTIONS 更新。

1. `src/docx/structure.ts` — IR → structure JSON：
   - headings 树（heading 样式段落 → 层级树）
   - 表格/图片/分节/域清单（含页眉页脚内容）
   - 元信息：段落数/图片数/表格数/分节数/总字符数/截断量
2. `src/docxTools.ts` 改造：
   - read_docx：加 `structure?: boolean`、`images?: "placeholder"|"skip"|"base64"` 参数；默认输出 markdown + 元信息行；截断时输出统计
   - write_docx：走 mdToModel → modelToDocxBuffer；参数不变
   - formatDocxResult/formatDocxGenResult 更新
3. `DOCX_INSTRUCTIONS` 更新（新能力说明）
4. 测试 `src/docxTools.test.ts` 扩展 + smoke-mcp.ts docx 冒烟用例更新
5. 移除 mammoth 依赖（package.json + 代码）

**验收**：工具层测试全绿；冒烟通过；mammoth 移除后 build 通过。

## 依赖与风险

- 全程不引第三方 XML 库（自研轻量遍历），避免 npm 网络依赖
- 阶段 2/3 的 gen.ts 平移是最大工作量，注意保持现有渲染行为
- 每阶段结束跑 `pnpm test`（vitest）确认全绿再进下一阶段
