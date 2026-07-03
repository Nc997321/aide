# Edit 工具卡片 diff 渲染 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让聊天流里的 `Edit` 工具调用卡片展示改动内容（整段红/绿块 diff + 折叠态行数统计），而不是只显示文件名和一句确认文本。

**Architecture:** 三层改动——(1) 把 `FileViewer.vue` 里已有的 unified diff 行着色样式从组件私有 scoped 样式上移为 `global.css` 的共享 class，消除即将出现的重复；(2) 新增一个纯函数工具模块 `src/utils/editDiff.ts`，负责把 `Edit` 工具的 `input` 解析成整段红/绿行数组（不做逐行 LCS 比对），这部分逻辑不依赖 Vue，可以直接用现有 vitest 配置（`environment: "node"`）做单元测试；(3) `ToolCallBlock.vue` 消费这个工具函数，在展开态渲染 diff、在折叠态的标题栏追加 `+N -M` 统计。

**Tech Stack:** Vue 3 `<script setup>` + TypeScript，Vitest（`environment: "node"`，无 jsdom/@vue-test-utils，本项目目前所有测试都是纯函数级别），Tailwind + 项目自有 CSS 变量（`src/styles/global.css`）。

## Global Constraints

- 只处理 `Edit` 工具，不处理 `Write`/`MultiEdit`。
- diff 粒度是整段红/绿块（`old_string` 整体标红、`new_string` 整体标绿），不引入 diff 算法依赖，不做逐行比对。
- `isError` 为 true 时不渲染 diff，回退到现有的错误文本展示。
- 折叠状态是默认状态（不改变现有交互习惯），标题栏追加 `+N -M` 行数统计。
- 新增的类型/解析函数不进 `src/types/chat.ts`（那是 provider-agnostic 的核心 IPC 协议类型，`Edit` 工具输入形状是 Claude 专属的展示层可选增强）。
- 共享的 diff 行着色 class 命名沿用项目已有的 `aide-` 前缀全局 class 惯例（`src/styles/global.css` 里已有 `.aide-tooltip` 先例）。
- 包管理器是 pnpm，类型检查命令是 `vue-tsc --noEmit`，测试命令是 `vitest run`。

---

### Task 1: 把 diff 行着色样式从 FileViewer.vue 私有样式上移到 global.css

**Files:**
- Modify: `src/styles/global.css`（追加，文件当前 94 行）
- Modify: `src/components/FileViewer.vue:94-107`（`diffHighlighted` computed）
- Modify: `src/components/FileViewer.vue:700-716`（`<style>` 里的 diff 相关规则）

**Interfaces:**
- Produces: 5 个全局 CSS class `aide-diff-add` / `aide-diff-del` / `aide-diff-hunk` / `aide-diff-meta` / `aide-diff-ctx`，供 Task 3 的 `ToolCallBlock.vue` 复用。

这是纯 CSS/模板重构，不涉及新逻辑，没有可写的单元测试——用「读现状 → 改 → 手动视觉回归」的步骤代替 TDD 循环。

- [ ] **Step 1: 在 `global.css` 末尾追加共享 diff 行 class**

在 `src/styles/global.css` 文件末尾（第 94 行 `.aide-tooltip.visible { opacity: 1; }` 之后）追加：

```css

/* ── Diff 行着色（FileViewer 的 git diff 视图 + ToolCallBlock 的 Edit 工具 diff 共用）── */
.aide-diff-add { color: var(--aide-success); background: color-mix(in srgb, var(--aide-success) 4%, transparent); display: block; }
.aide-diff-del { color: var(--aide-danger); background: color-mix(in srgb, var(--aide-danger) 4%, transparent); display: block; }
.aide-diff-hunk { color: var(--aide-info); display: block; }
.aide-diff-meta { color: var(--aide-warning); display: block; }
.aide-diff-ctx { color: var(--aide-text-muted); display: block; }
```

- [ ] **Step 2: 更新 `FileViewer.vue` 的 `diffHighlighted` computed 使用新 class 名**

把 `src/components/FileViewer.vue:94-107` 的 `diffHighlighted` 改成引用 `aide-diff-*`：

```ts
const diffHighlighted = computed(() => {
  if (!content.value) return "";
  return content.value.split("\n").map((line) => {
    let cls = "aide-diff-ctx";
    if (line.startsWith("+") && !line.startsWith("+++")) cls = "aide-diff-add";
    else if (line.startsWith("-") && !line.startsWith("---")) cls = "aide-diff-del";
    else if (line.startsWith("@@")) cls = "aide-diff-hunk";
    else if (line.startsWith("diff ") || line.startsWith("index ") ||
             line.startsWith("--- ") || line.startsWith("+++ ") ||
             line.startsWith("new file") || line.startsWith("deleted file"))
      cls = "aide-diff-meta";
    return `<span class="${cls}">${escapeHtml(line)}</span>`;
  }).join("\n");
});
```

- [ ] **Step 3: 删除 `FileViewer.vue` 里现在重复的 scoped 颜色规则**

把 `src/components/FileViewer.vue:700-716` 从：

```css
/* ── Diff viewer ── */
.viewer-diff {
  display: block;
  padding: 12px 16px;
  margin: 0;
  font-family: "Cascadia Code", "Fira Code", "JetBrains Mono", "Consolas", monospace;
  font-size: 12px;
  line-height: 1.6;
  color: var(--aide-text-primary);
  white-space: pre;
  tab-size: 4;
}
.viewer-diff .diff-add { color: var(--aide-success); background: color-mix(in srgb, var(--aide-success) 4%, transparent); display: block; }
.viewer-diff .diff-del { color: var(--aide-danger); background: color-mix(in srgb, var(--aide-danger) 4%, transparent); display: block; }
.viewer-diff .diff-hunk { color: var(--aide-info); display: block; }
.viewer-diff .diff-meta { color: var(--aide-warning); display: block; }
.viewer-diff .diff-ctx { color: var(--aide-text-muted); display: block; }
```

改成（只保留布局属性，颜色规则交给 global.css 里的 `aide-diff-*`）：

```css
/* ── Diff viewer（着色规则见 src/styles/global.css 的 aide-diff-*）── */
.viewer-diff {
  display: block;
  padding: 12px 16px;
  margin: 0;
  font-family: "Cascadia Code", "Fira Code", "JetBrains Mono", "Consolas", monospace;
  font-size: 12px;
  line-height: 1.6;
  color: var(--aide-text-primary);
  white-space: pre;
  tab-size: 4;
}
```

- [ ] **Step 4: 类型检查**

Run: `pnpm exec vue-tsc --noEmit`
Expected: 无新增报错（这一步是纯样式/字符串改动，不应该产生类型错误）。

- [ ] **Step 5: 手动视觉回归 —— 确认 GitPanel 的 git diff 查看器没有变化**

Run: `pnpm dev`（或已有 `dev.ps1`）启动应用，在 GitPanel 里点开任意一个有改动的文件查看 diff。

Expected: 新增行仍然是绿色背景、删除行仍然是红色背景、`@@` hunk 行仍然是蓝色、`diff --git`/`index`/`---`/`+++` 元信息行仍然是黄色，视觉效果和改动前完全一致（因为颜色值和 class 语义没变，只是搬了位置）。

- [ ] **Step 6: Commit**

```bash
git add src/styles/global.css src/components/FileViewer.vue
git commit -m "$(cat <<'EOF'
refactor(diff): 抽取 FileViewer 的 diff 行着色为全局共享 class

为 ToolCallBlock.vue 即将复用的 Edit diff 渲染做准备，避免颜色规则在两个组件里各写一份。
EOF
)"
```

---

### Task 2: 新增 `src/utils/editDiff.ts`（Edit 输入解析 + 整段红/绿 diff 计算）

**Files:**
- Create: `src/utils/editDiff.ts`
- Test: `src/utils/editDiff.test.ts`

**Interfaces:**
- Consumes: 无（纯函数，不依赖其他任务的产出）。
- Produces:
  - `interface EditToolInput { file_path: string; old_string: string; new_string: string }`
  - `function parseEditInput(input: unknown): EditToolInput | null`
  - `interface DiffLine { text: string; cls: "aide-diff-del" | "aide-diff-add" }`
  - `interface EditDiffStats { lines: DiffLine[]; addCount: number; delCount: number }`
  - `function buildEditDiffLines(edit: EditToolInput): EditDiffStats`
  - Task 3 的 `ToolCallBlock.vue` 会 `import { parseEditInput, buildEditDiffLines } from "@/utils/editDiff"`。

- [ ] **Step 1: 写失败的测试**

创建 `src/utils/editDiff.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { parseEditInput, buildEditDiffLines } from "./editDiff";

describe("parseEditInput", () => {
  it("returns null for non-object input", () => {
    expect(parseEditInput(null)).toBeNull();
    expect(parseEditInput("Edit path")).toBeNull();
    expect(parseEditInput(undefined)).toBeNull();
  });

  it("returns null when a required field is missing", () => {
    expect(parseEditInput({ file_path: "a.ts", old_string: "x" })).toBeNull();
  });

  it("returns null when a field has the wrong type", () => {
    expect(parseEditInput({ file_path: "a.ts", old_string: 1, new_string: "y" })).toBeNull();
  });

  it("parses a valid Edit input, ignoring extra fields like replace_all", () => {
    expect(
      parseEditInput({ file_path: "a.ts", old_string: "foo", new_string: "bar", replace_all: true }),
    ).toEqual({ file_path: "a.ts", old_string: "foo", new_string: "bar" });
  });
});

describe("buildEditDiffLines", () => {
  it("builds del lines then add lines for single-line strings", () => {
    const result = buildEditDiffLines({ file_path: "a.ts", old_string: "foo", new_string: "bar" });
    expect(result.lines).toEqual([
      { text: "-foo", cls: "aide-diff-del" },
      { text: "+bar", cls: "aide-diff-add" },
    ]);
    expect(result.delCount).toBe(1);
    expect(result.addCount).toBe(1);
  });

  it("splits multi-line old_string/new_string into one entry per line", () => {
    const result = buildEditDiffLines({
      file_path: "a.ts",
      old_string: "line1\nline2",
      new_string: "line1\nline2\nline3",
    });
    expect(result.lines).toEqual([
      { text: "-line1", cls: "aide-diff-del" },
      { text: "-line2", cls: "aide-diff-del" },
      { text: "+line1", cls: "aide-diff-add" },
      { text: "+line2", cls: "aide-diff-add" },
      { text: "+line3", cls: "aide-diff-add" },
    ]);
    expect(result.delCount).toBe(2);
    expect(result.addCount).toBe(3);
  });

  it("treats an empty string as a single empty line", () => {
    const result = buildEditDiffLines({ file_path: "a.ts", old_string: "", new_string: "x" });
    expect(result.lines[0]).toEqual({ text: "-", cls: "aide-diff-del" });
    expect(result.delCount).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm exec vitest run src/utils/editDiff.test.ts`
Expected: FAIL，报错类似 `Cannot find module './editDiff'`（文件还不存在）。

- [ ] **Step 3: 写最小实现**

创建 `src/utils/editDiff.ts`：

```ts
export interface EditToolInput {
  file_path: string;
  old_string: string;
  new_string: string;
}

/** 校验 Edit 工具的 input 形状；字段缺失或类型不对时返回 null，让调用方静默回退。 */
export function parseEditInput(input: unknown): EditToolInput | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  if (
    typeof obj.file_path !== "string" ||
    typeof obj.old_string !== "string" ||
    typeof obj.new_string !== "string"
  ) {
    return null;
  }
  return { file_path: obj.file_path, old_string: obj.old_string, new_string: obj.new_string };
}

export interface DiffLine {
  text: string;
  cls: "aide-diff-del" | "aide-diff-add";
}

export interface EditDiffStats {
  lines: DiffLine[];
  addCount: number;
  delCount: number;
}

/**
 * 整段红/绿块 diff：old_string 逐行标红在前，new_string 逐行标绿在后。
 * 不做逐行比对（不是真正的 LCS diff），只是把两段文本按行拆开分别着色。
 */
export function buildEditDiffLines(edit: EditToolInput): EditDiffStats {
  const delTextLines = edit.old_string.split("\n");
  const addTextLines = edit.new_string.split("\n");
  const lines: DiffLine[] = [
    ...delTextLines.map((text): DiffLine => ({ text: `-${text}`, cls: "aide-diff-del" })),
    ...addTextLines.map((text): DiffLine => ({ text: `+${text}`, cls: "aide-diff-add" })),
  ];
  return { lines, addCount: addTextLines.length, delCount: delTextLines.length };
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `pnpm exec vitest run src/utils/editDiff.test.ts`
Expected: PASS，7 个测试用例全绿。

- [ ] **Step 5: 类型检查**

Run: `pnpm exec vue-tsc --noEmit`
Expected: 无报错。

- [ ] **Step 6: Commit**

```bash
git add src/utils/editDiff.ts src/utils/editDiff.test.ts
git commit -m "$(cat <<'EOF'
feat(diff): 新增 Edit 工具输入解析与整段 diff 计算

纯函数，不依赖 Vue，为 ToolCallBlock.vue 渲染 Edit diff 做准备。
EOF
)"
```

---

### Task 3: `ToolCallBlock.vue` 渲染 Edit diff + 折叠态行数统计

**Files:**
- Modify: `src/components/ToolCallBlock.vue`（整份重写 `<script setup>` 和模板/样式的相关部分，文件当前 114 行）

**Interfaces:**
- Consumes: `parseEditInput`、`buildEditDiffLines`、`EditDiffStats`（Task 2 产出，从 `@/utils/editDiff` 导入）；`aide-diff-add`/`aide-diff-del`（Task 1 产出的全局 class）。
- Produces: 无下游消费者（这是最终渲染层）。

这一步是纯 Vue 组件渲染逻辑，项目里没有组件级测试基建（`vitest.config.ts` 是 `environment: "node"`，没有 jsdom/`@vue/test-utils`，参见 spec 里的调研），所以用手动交互验证代替自动化测试，和 Task 1 一样。

- [ ] **Step 1: 修改 `<script setup>`**

把 `src/components/ToolCallBlock.vue:1-23` 替换成：

```ts
<script setup lang="ts">
import { ref, computed } from "vue";
import type { ToolCallBlock } from "@/types/chat";
import BashOutputBlock from "./BashOutputBlock.vue";
import { parseEditInput, buildEditDiffLines, type EditDiffStats } from "@/utils/editDiff";

const props = defineProps<{ block: ToolCallBlock }>();
const expanded = ref(false);

const statusIcon = computed(() => {
  if (props.block.isPending) return "⏳";
  if (props.block.isError) return "❌";
  return "✅";
});

const isBash = computed(() => props.block.name === "Bash");

/** Edit 工具且非错误时的 diff 数据；null 表示回退到普通结果文本展示。 */
const editDiff = computed<EditDiffStats | null>(() => {
  if (props.block.name !== "Edit" || props.block.isError) return null;
  const parsed = parseEditInput(props.block.input);
  if (!parsed) return null;
  return buildEditDiffLines(parsed);
});

const inputSummary = computed(() => {
  const input = props.block.input as Record<string, unknown>;
  if (props.block.name === "Bash") return String(input?.command ?? "");
  if (["Read", "Write", "Edit"].includes(props.block.name))
    return String(input?.file_path ?? "");
  return JSON.stringify(input).slice(0, 80);
});
</script>
```

- [ ] **Step 2: 修改模板**

把 `src/components/ToolCallBlock.vue` 里原来的 `<template>` 块（原第 25-39 行）替换成：

```html
<template>
  <div class="tool-block">
    <button class="tool-header" @click="expanded = !expanded">
      <span class="tool-status">{{ statusIcon }}</span>
      <span class="tool-name">{{ block.name }}</span>
      <span class="tool-summary">{{ inputSummary }}</span>
      <span v-if="editDiff" class="tool-diff-stat">
        <span class="stat-add">+{{ editDiff.addCount }}</span>
        <span class="stat-del">-{{ editDiff.delCount }}</span>
      </span>
      <span class="tool-chevron">{{ expanded ? "▲" : "▼" }}</span>
    </button>
    <div v-if="expanded" class="tool-body">
      <BashOutputBlock v-if="isBash && block.result" :content="block.result" :is-error="block.isError ?? false" />
      <pre v-else-if="editDiff" class="tool-result tool-diff"><span v-for="(line, i) in editDiff.lines" :key="i" :class="line.cls">{{ line.text }}</span></pre>
      <pre v-else-if="block.result" class="tool-result">{{ block.result }}</pre>
      <div v-else class="tool-pending">等待结果…</div>
    </div>
  </div>
</template>
```

注意 `<pre>` 那一行必须保持标签之间没有多余空白/换行（`<pre>` 会把源码里的空白原样显示出来），这是照抄 `FileViewer.vue` 里 `<pre v-else-if="isDiff"><code ...></code></pre>` 的既有写法。

- [ ] **Step 3: 追加样式**

在 `src/components/ToolCallBlock.vue` 的 `<style scoped>` 块里，`.tool-result` 规则（原第 100-108 行）后面追加：

```css
.tool-diff {
  white-space: pre;
}

.tool-diff-stat {
  flex-shrink: 0;
  display: flex;
  gap: 4px;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  font-size: 11px;
}

.stat-add {
  color: var(--aide-success);
}

.stat-del {
  color: var(--aide-danger);
}
```

- [ ] **Step 4: 类型检查**

Run: `pnpm exec vue-tsc --noEmit`
Expected: 无报错。

- [ ] **Step 5: 手动验证 —— 正常 Edit**

Run: `pnpm dev` 启动应用，发一条会触发 Edit 工具的消息（比如让 Claude 改当前项目里任意一个已存在文件的一行内容）。

Expected:
- 折叠态标题栏：图标 + `Edit` + 文件路径 + `+1 -1`（绿/红色数字）+ 折叠箭头。
- 点击展开：看到红色背景行（`-` 前缀，原内容）在上，绿色背景行（`+` 前缀，新内容）在下。

- [ ] **Step 6: 手动验证 —— 失败 Edit**

构造一次会失败的 Edit（比如让 Claude 尝试把 `old_string` 设成文件里出现多次的字符串，触发 SDK 的"not unique"报错；或者直接观察某次真实失败调用）。

Expected: 折叠态标题栏图标是 ❌，不显示 `+N -M` 统计；展开后看到的是原来的纯文本错误信息，不是 diff 色块。

- [ ] **Step 7: 手动验证 —— 其他工具卡片不受影响**

观察同一轮对话里的 `Read`/`Bash`/`Write` 等其他工具卡片。

Expected: 渲染和改动前完全一样（`Read`/`Write` 折叠态摘要仍是文件路径、无 `+N -M` 统计；`Bash` 仍走 `BashOutputBlock`）。

- [ ] **Step 8: 跑一遍现有单元测试，确认没有破坏其他模块**

Run: `pnpm test`
Expected: 全部 PASS（包括 Task 2 新增的 `editDiff.test.ts` 和已有的 `useChatSession.test.ts`/`fileMentions.test.ts`/`paste.test.ts`/`time.test.ts`）。

- [ ] **Step 9: Commit**

```bash
git add src/components/ToolCallBlock.vue
git commit -m "$(cat <<'EOF'
feat(chat): ToolCallBlock 渲染 Edit 工具的整段红绿 diff

聊天流里的 Edit 调用现在能直接看到改了什么，不用切到 GitPanel 或打开文件确认；
折叠态标题栏加 +N/-M 统计，失败的 Edit 调用仍回退到原来的错误文本展示。
EOF
)"
```

---

## Self-Review Notes

- **Spec 覆盖**：spec 的 6 个改动点（global.css 新增 class、FileViewer 迁移、ToolCallBlock 本地类型+解析+diff 渲染、标题栏统计、错误回退、超长滚动）分别落在 Task 1（前两点）、Task 2（类型与纯函数，唯一偏离 spec 字面表述——spec 说"本地 interface"，这里放进了可测试的 `src/utils/editDiff.ts`，理由见下）、Task 3（渲染、统计、错误回退沿用现有 `.tool-result` 的 `max-height/overflow` 实现超长滚动，未新写截断逻辑）。
- **与 spec 的一处偏离及理由**：spec 原文说 `EditToolInput` interface 和解析函数放在 `ToolCallBlock.vue` 内部。实现时改成独立的 `src/utils/editDiff.ts` 纯函数模块，因为项目现有 vitest 配置（`environment: "node"`）只能测纯 TS 逻辑，没有组件渲染测试基建；把解析和 diff 计算逻辑抽成纯函数是让这部分能被 TDD 覆盖的唯一方式，且完全符合 spec 的架构决策本身（"不进 `types/chat.ts`"）——只是换了一个同样不属于核心协议类型的文件位置，和项目已有的 `src/utils/fileMentions.ts`（同样是"解析+转换供组件消费"的纯函数模块，同样有 `.test.ts`）模式一致。
- **占位符扫描**：无 TBD/TODO，所有代码块都是完整可运行的实现，不是"仿照 Task N"的省略写法。
- **类型一致性**：`EditDiffStats`/`DiffLine`/`EditToolInput` 在 Task 2 定义、Task 3 原样导入使用，字段名（`lines`/`addCount`/`delCount`/`text`/`cls`）前后一致。
