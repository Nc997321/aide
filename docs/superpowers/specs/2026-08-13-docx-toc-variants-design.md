# 设计：write_docx 图表索引支持（TOC 变体 + Caption 样式）

日期：2026-08-13
状态：已实现并验证（Word COM 更新域实测通过）

## 背景

等保整改材料实战暴露：用户要"图表索引"（图目录 + 表目录），write_docx 不支持，只能手工做表格 + Word COM 填页码（绕路方案）。

## 核心洞察

TOC 页码是排版结果，生成端永远算不了——**任何方案都绕不开 Word 更新域**。所以正确路线不是预填表格，而是生成"活的"域结构，用户打开 Word 点一次"更新域"全自动。

## 方案

### 扩展语法（md 端）

| 语法 | 含义 | 生成 |
|---|---|---|
| `[TOC:figures]` | 图目录 | TOC 域 `TOC \t "FigureCaption,1" \h \z \u`（按 FigureCaption 样式收集） |
| `[TOC:tables]` | 表目录 | TOC 域 `TOC \t "TableCaption,1" \h \z \u`（按 TableCaption 样式收集） |
| `::: caption` | 图注段落 | 段落 style `FigureCaption`（自定义题注样式，居中） |
| `::: tablecaption` | 表注段落 | 段落 style `TableCaption`（basedOn FigureCaption） |

`[TOC]`（默认，按 Heading1-3 收集）不变。

### 关键实现点

1. **docx 库原生支持**：`TableOfContents` 的 `stylesWithLevels: [{ styleName, level }]` → instr `TOC \t "Caption,1"`（已验证 docx 库源码 FieldInstruction）。**不需要自己写 fldChar 序列**。
2. **IR 层不加字段**：Field 的 `instr` 是唯一事实源。toModel 生成不同 instr；gen 从 instr 解析 stylesWithLevels；toMarkdown 从 instr 解析输出变体；parse 端 instr 读回已有（classifyField 认 `TOC\b` 开头 → type "toc"，`TOC \t` 天然兼容）。
3. **Caption 样式兜底**：docx 库不内置 Caption，IR styles 里也没有（markdown 无样式定义）。gen 端仿 `tocFallbackStyles` 兜底生成 FigureCaption/TableCaption（basedOn Normal，居中，小字）。
4. **⚠️ 不能用 "Caption"（Word 内置样式名）**：实测任何 name="caption" 的样式都会被 Word 强制规范化 styleId（"Caption"→"ac"），`\t "caption,1"` 匹配失败（"未找到目录项"）。用完全自定义名 `FigureCaption` 避开——Word 保留 styleId，`\t` 按 styleId 匹配成功（Word COM 更新域实测：图注/表注 4 条全部收集）。
4. **`::: caption` 复用 pendingAlign 机制**：`::: center` 是"后续段落对齐"，caption 同理设 pendingStyle，下一个段落消费。

### 文件改动

| 文件 | 改动 |
|---|---|
| `md/toModel.ts` | parseExt 加 `<!--toc:figures-->`/`<!--toc:tables-->`；toc case 按 variant 生成 instr；align case 加 caption/tablecaption → pendingStyle |
| `gen/body.ts` | fieldToDocx 从 instr 解析 `\t "..."` → stylesWithLevels（默认仍 headingStyleRange） |
| `gen/styles.ts` | 加 captionFallbackStyles（FigureCaption/TableCaption 兜底，仿 tocFallbackStyles） |
| `gen/index.ts` | 合并 captionFallbackStyles |
| `md/toMarkdown.ts` | fieldToMd 从 instr 输出 `[TOC:figures]`/`[TOC:tables]`；paragraphToMd style FigureCaption/TableCaption → `::: caption`/`::: tablecaption` |
| `docxTools.ts` | DOCX_INSTRUCTIONS 补扩展语法说明（hasTocField 已覆盖变体——field.type 仍为 "toc"） |

### 测试

- md/model.test.ts：`[TOC:figures]` → instr 断言；`::: caption` → style 断言；round-trip 变体
- gen/model.test.ts：stylesWithLevels 生成 round-trip（instr 读回）
- docxTools.test.ts：hasTocField 覆盖变体

### 不做的事

- 不预填页码（Word 更新域自动填）
- 不做 SEQ 域题注编号（`\c` 指令路线，需要 SEQ 域，复杂；`\t` 按样式收集足够）
- 不改 parse 端（instr 读回已有）
