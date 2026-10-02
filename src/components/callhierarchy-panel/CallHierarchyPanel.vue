<script setup lang="ts">
// 右侧栏「调用层级」面板（callHierarchy）——审阅场景「这个方法被谁在用」。
//
// 形态（2026-09-02 设计对齐，原型 docs/superpowers/design-previews/2026-09-02-callhierarchy-panel.html）：
// 常驻面板而非模态弹窗——调用链审阅是「看链 → 跳去读代码 → 回来展开更深 → 换方向」的
// 循环，弹窗的「选一次即消失」契约会在每次跳转时清零探索状态（IDEA/VS Code/Eclipse
// 清一色常驻 view，行业零模态先例）。
//
// 结构：panel-header + 根胶囊 + incoming/outgoing 方向分段 + 扁平化树区。
// 数据/状态权威在 useCallHierarchy 单例（gutter ⇄ 触发点在编辑器深处）；本组件只做
// 渲染与点击分发。树扁平化（DFS→行数组）替代递归组件：状态全在 composable，扁平化
// 只读 + computed 自动重算，环防御走 path 集合。
import { computed } from "vue";
import {
  useCallHierarchy, callNodeKey,
} from "../../composables/useCallHierarchy";
import type { CallHierarchyNode } from "../../types";

const ch = useCallHierarchy();

// LSP SymbolKind → 短图标（与主题色槽对齐：方法/函数=accent 紫族由 CSS 类控制）
function kindIcon(kind: number): string {
  switch (kind) {
    case 6: return "ƒ";      // Method
    case 12: return "ƒ";     // Function
    case 9: return "◇";      // Constructor
    case 5: return "C";      // Class
    case 11: return "I";     // Interface
    case 23: return "S";     // Struct
    case 2: return "M";      // Module
    default: return "•";
  }
}

/** 根的声明位置展示（相对路径直接显示；长路径靠 CSS 截断）。 */
const rootLocation = computed(() => {
  const r = ch.root.value;
  if (!r) return "";
  return `${r.file}:${r.line}`;
});

type Row =
  | { type: "node"; node: CallHierarchyNode; depth: number; expanded: boolean; expanding: boolean; failed: boolean }
  | { type: "site"; node: CallHierarchyNode; line: number; column: number; depth: number }
  | { type: "term"; depth: number }
  | { type: "fail"; node: CallHierarchyNode; depth: number };

/** 树扁平化：节点行 + （展开时）调用点子行 + 终止行/失败行。path 集合防递归环。 */
const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  const rootPath = new Set<string>();
  const r = ch.root.value;
  if (r) rootPath.add(callNodeKey(r));
  const walk = (nodes: CallHierarchyNode[], depth: number, path: Set<string>) => {
    for (const n of nodes) {
      const key = callNodeKey(n);
      if (path.has(key)) continue; // 环防御：A→B→A 只展开一次
      const expanded = ch.expandedKeys.value.has(key);
      out.push({
        type: "node", node: n, depth,
        expanded,
        expanding: ch.expandingKeys.value.has(key),
        failed: ch.expandFailKeys.value.has(key),
      });
      if (expanded) {
        // 调用点子行（fromRanges）：节点正下方，先于下一层
        for (const s of n.callSites) {
          out.push({ type: "site", node: n, line: s.line, column: s.column, depth: depth + 1 });
        }
        const kids = ch.childrenByNode.value.get(key) ?? [];
        if (kids.length === 0) {
          out.push({ type: "term", depth: depth + 1 });
        } else {
          const nextPath = new Set(path);
          nextPath.add(key);
          walk(kids, depth + 1, nextPath);
        }
      }
    }
  };
  walk(ch.firstLevel.value, 0, rootPath);
  return out;
});

/** 缩进（每层 14px） */
function pad(depth: number): string {
  return `${depth * 14}px`;
}

function onRowNode(n: CallHierarchyNode) {
  void ch.jumpToNode(n);
}
function onChevron(n: CallHierarchyNode) {
  void ch.toggleNode(n);
}
function onSite(n: CallHierarchyNode, line: number, column: number) {
  void ch.jumpToSite(n, line, column);
}
function onRetryNode(n: CallHierarchyNode) {
  void ch.retryNode(n);
}

/** 根状态提示（status 非 ok 或 prepare 空） */
const rootHint = computed<{ kind: "timeout" | "notready" | "gone" | "unsupported"; text: string } | null>(() => {
  if (!ch.rootQuery.value) return null;
  if (ch.loadingRoot.value) return null;
  switch (ch.rootStatus.value) {
    case "timeout":
      return { kind: "timeout", text: "语言服务响应超时" };
    case "not_ready":
      return { kind: "notready", text: "语言服务未就绪（索引中或未启动）" };
    case "gone":
      return { kind: "gone", text: "语言服务已退出" };
    case "ok":
      // prepare 空：该位置不是可调用符号（类名/字段等）
      if (!ch.root.value) {
        return { kind: "unsupported", text: "该符号不支持调用层级（不可调用）。类/类型的引用请用 Alt+Click 查引用。" };
      }
      return null;
    default:
      return null; // 查询中
  }
});
</script>

<template>
  <div class="ch-panel">
    <!-- 面板壳：同 PermissionsPanel 的 panel-header + 滚动区结构 -->
    <div class="panel-header">
      <span class="panel-title">调用层级</span>
      <button
        v-if="ch.root.value || ch.rootQuery.value"
        class="ch-clear"
        title="清空"
        @click="ch.clear()"
      >×</button>
    </div>

    <!-- 根胶囊 + 方向分段（根在时才显示） -->
    <div v-if="ch.root.value" class="ch-root-bar">
      <div class="ch-root-chip" :title="`${ch.root.value.name} · ${rootLocation}`">
        <span class="ch-kind">{{ kindIcon(ch.root.value.kind) }}</span>
        <span class="ch-root-name">{{ ch.root.value.name }}</span>
        <span class="ch-root-loc">{{ rootLocation }}</span>
      </div>
      <div class="ch-seg">
        <button
          class="ch-seg-btn"
          :class="{ on: ch.direction.value === 'incoming' }"
          title="谁调用了它（调用方）"
          @click="ch.setDirection('incoming')"
        >⇠ 调用者</button>
        <button
          class="ch-seg-btn"
          :class="{ on: ch.direction.value === 'outgoing' }"
          title="它调用了谁（被调用方）"
          @click="ch.setDirection('outgoing')"
        >被调用 ⇢</button>
      </div>
    </div>

    <!-- 树区 -->
    <div class="ch-tree">
      <!-- 空态 -->
      <div v-if="!ch.rootQuery.value" class="ch-empty">
        <span class="ch-empty-ico">⇄</span>
        <p>点击编辑器 gutter 的 <b class="ch-accent">⇄</b> 标记<br>查看方法的调用层级</p>
        <p class="ch-empty-sub">调用者：谁在用这个方法<br>被调用：它用了哪些方法</p>
      </div>

      <!-- 根查询中 -->
      <div v-else-if="ch.loadingRoot.value" class="ch-state">
        <span class="ch-spin"></span> 正在查询调用层级…
      </div>

      <!-- 状态提示（超时/未就绪/不支持） -->
      <div v-else-if="rootHint" class="ch-state">
        <template v-if="rootHint.kind === 'unsupported'">
          <span class="ch-empty-ico small">⇄</span>
          <p>{{ rootHint.text }}</p>
        </template>
        <template v-else>
          <p>{{ rootHint.text }}</p>
          <button v-if="rootHint.kind === 'timeout'" class="ch-retry" @click="ch.retry()">重试</button>
        </template>
      </div>

      <!-- 树 -->
      <template v-else>
        <div v-if="rows.length === 0" class="ch-state">
          {{ ch.direction.value === "incoming" ? "没有调用方（入口/未被使用）" : "没有被调用方（叶子）" }}
        </div>
        <template v-for="(row, i) in rows" :key="`${i}-${row.type}-${row.type === 'node' || row.type === 'fail' ? callNodeKey(row.node) : row.type === 'site' ? `${row.node.name}:${row.line}:${row.column}` : i}`">
          <!-- 节点行 -->
          <div
            v-if="row.type === 'node'"
            class="ch-row"
            :style="{ paddingLeft: pad(row.depth) }"
            :title="`${row.node.name}${row.node.detail ? ' · ' + row.node.detail : ''} · ${row.node.file}:${row.node.line}`"
            @click="onRowNode(row.node)"
          >
            <span
              class="ch-chev"
              :class="{ open: row.expanded, spin: row.expanding }"
              @click.stop="onChevron(row.node)"
            >
              <span v-if="row.expanding" class="ch-spin"></span>
              <template v-else>{{ row.expanded ? "▾" : "▸" }}</template>
            </span>
            <span class="ch-kind">{{ kindIcon(row.node.kind) }}</span>
            <span class="ch-name">{{ row.node.name }}</span>
            <span
              v-if="row.node.callSites.length > 1"
              class="ch-count"
              :title="`该符号有 ${row.node.callSites.length} 个调用点（fromRanges），展开查看`"
            >×{{ row.node.callSites.length }}</span>
            <span class="ch-file">{{ row.node.file }}</span>
          </div>

          <!-- 调用点子行（fromRanges） -->
          <div
            v-else-if="row.type === 'site'"
            class="ch-row ch-site-row"
            :style="{ paddingLeft: pad(row.depth + 1) }"
            title="调用点（fromRanges）：跳到该调用处"
            @click="onSite(row.node, row.line, row.column)"
          >
            <span class="ch-site-arr">⤳</span>
            <span class="ch-site-pos">L{{ row.line }}:{{ row.column }}</span>
          </div>

          <!-- 终止行 -->
          <div v-else-if="row.type === 'term'" class="ch-term" :style="{ paddingLeft: pad(row.depth + 1) }">
            — {{ ch.direction.value === "incoming" ? "链到此为止（入口）" : "链到此为止（叶子）" }}
          </div>

          <!-- 展开失败行 -->
          <div v-else class="ch-term ch-fail" :style="{ paddingLeft: pad(row.depth + 1) }">
            查询失败
            <button class="ch-retry" @click="onRetryNode(row.node)">重试</button>
          </div>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* ===== 面板壳：同 PermissionsPanel 结构 ===== */
.ch-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--aide-bg-deep);
  overflow: hidden;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--aide-surface-default);
  flex-shrink: 0;
}

.panel-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--aide-text-primary);
  white-space: nowrap;
}

.ch-clear {
  border: none;
  background: transparent;
  color: var(--aide-text-muted);
  font-size: 15px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
}
.ch-clear:hover { color: var(--aide-text-primary); background: var(--aide-surface-hover); }

/* ===== 根胶囊 + 方向分段 ===== */
.ch-root-bar {
  flex-shrink: 0;
  padding: 8px 10px;
  border-bottom: 1px solid var(--aide-surface-default);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ch-root-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-surface-hover);
}

.ch-root-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--aide-accent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ch-root-loc {
  font-size: 10.5px;
  color: var(--aide-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 1;
}

.ch-seg {
  display: flex;
  border: 1px solid var(--aide-surface-hover);
  border-radius: 6px;
  overflow: hidden;
}

.ch-seg-btn {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--aide-text-muted);
  font-size: 12px;
  padding: 5px 0;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.ch-seg-btn + .ch-seg-btn { border-left: 1px solid var(--aide-surface-hover); }
.ch-seg-btn:hover { color: var(--aide-text-primary); }
.ch-seg-btn.on {
  background: var(--aide-surface-default);
  color: var(--aide-accent);
  font-weight: 600;
}

/* ===== 树区 ===== */
.ch-tree {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 4px 12px 8px;
}
.ch-tree::-webkit-scrollbar { width: 4px; }
.ch-tree::-webkit-scrollbar-track { background: transparent; }
.ch-tree::-webkit-scrollbar-thumb { background: var(--aide-surface-hover); border-radius: 2px; }

.ch-row {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 2px 6px 2px 0;
  border-radius: 4px;
  cursor: pointer;
  min-height: 22px;
}
.ch-row:hover { background: var(--aide-surface-hover); }

.ch-chev {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: var(--aide-text-muted);
  border-radius: 3px;
}
.ch-chev:hover { color: var(--aide-text-primary); background: var(--aide-surface-default); }
.ch-chev.open { color: var(--aide-accent); }

.ch-kind {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  color: var(--aide-text-muted);
  width: 12px;
  text-align: center;
}

.ch-name {
  font-size: 12px;
  color: var(--aide-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ch-count {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--aide-accent);
  background: var(--aide-surface-default);
  border-radius: 8px;
  padding: 0 5px;
  line-height: 15px;
}

.ch-file {
  flex-shrink: 1;
  margin-left: auto;
  font-size: 10px;
  color: var(--aide-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 45%;
}

.ch-site-row {
  color: var(--aide-text-muted);
}
.ch-site-row:hover { color: var(--aide-text-primary); }
.ch-site-arr { font-size: 10px; color: var(--aide-text-muted); }
.ch-site-pos {
  font-size: 10.5px;
  font-family: var(--aide-font-mono, ui-monospace, monospace);
}

.ch-term {
  font-size: 10.5px;
  color: var(--aide-text-muted);
  padding: 1px 6px 1px 0;
  opacity: 0.8;
}

.ch-fail { color: var(--aide-warning, #b8860b); }

.ch-retry {
  border: 1px solid var(--aide-surface-hover);
  background: transparent;
  color: var(--aide-accent);
  font-size: 10.5px;
  padding: 1px 8px;
  border-radius: 4px;
  cursor: pointer;
  margin-left: 6px;
}
.ch-retry:hover { background: var(--aide-surface-hover); }

/* ===== 状态/空态 ===== */
.ch-state {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 18px 14px;
  font-size: 12px;
  color: var(--aide-text-muted);
  text-align: center;
  line-height: 1.6;
}

.ch-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 36px 16px;
  text-align: center;
  color: var(--aide-text-muted);
  font-size: 12px;
  line-height: 1.7;
}
.ch-empty-ico {
  font-size: 26px;
  color: var(--aide-accent);
  opacity: 0.7;
}
.ch-empty-ico.small { font-size: 18px; }
.ch-empty p { margin: 0; }
.ch-empty-sub { font-size: 10.5px; opacity: 0.75; }
.ch-accent { color: var(--aide-accent); }

.ch-spin {
  display: inline-block;
  width: 11px;
  height: 11px;
  border: 2px solid var(--aide-surface-hover);
  border-top-color: var(--aide-accent);
  border-radius: 50%;
  animation: ch-rotate 0.7s linear infinite;
  flex-shrink: 0;
}
@keyframes ch-rotate {
  to { transform: rotate(360deg); }
}
</style>
