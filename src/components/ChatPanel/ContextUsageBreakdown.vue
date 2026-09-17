<script setup lang="ts">
/**
 * ContextUsageBreakdown —— 上下文用量的「占用来源」区（ContextUsagePanel 的子视图）。
 *
 * 与上方分类列表的关系：分类列表答「窗口怎么分块」（provider 自报的 categories），
 * 这里答「这些 token 是谁的」（SDK 的明细分组：哪个 MCP server 的哪条工具、哪份记忆
 * 文件…）。两个切面粒度不同、**不保证合计相等**，所以独立成区，而不是挂到分类行上
 * 做下钻（挂靠会建立在一个不存在的恒等式上）。
 *
 * 结构：可折叠 section（默认全收起，header 即合计——一眼看到账，点开才铺明细）。
 * MCP 组多一层：section → server（可再展开到工具），因为单看平铺的工具名答不出
 * "哪个 server 在吃"。折叠状态住本组件：panel 由父 v-if 挂载，重开即重置。
 *
 * 几何：面板的 position() 只在打开时量一次高度、展开后不重算，所以"展开不掀翻面板"
 * 只能靠两条一起保证——① 明细区 max-height 把高度增幅封顶；② 面板向上弹时锚
 * bottom（见 ContextUsagePanel.position），长高只向上伸，不会把底边推向输入框。
 *
 * 归组/排序/合计策略不在本组件——见同目录 contextUsage.ts（纯核心，可直测）。
 */
import { computed, ref } from "vue";
import type { ContextUsageBreakdown, ContextUsageNamedItem } from "@/types/chat";
import { formatTokens, groupMcpByServer, sortByTokensDesc, sumTokens } from "./contextUsage";

const props = defineProps<{
  /** 占用来源明细；六组各自可选，缺席的组不渲染 section。 */
  breakdown: ContextUsageBreakdown;
}>();

/** 一行明细。有 children 的行渲染成可点开的折叠头（目前只有 MCP server）。 */
interface BreakdownRow {
  readonly key: string;
  readonly label: string;
  /** provider 自报的不透明来源标签（记忆文件的 type、子代理的 source）；空则不显示。 */
  readonly note?: string;
  readonly tokens: number;
  readonly children?: readonly BreakdownChild[];
}
interface BreakdownChild {
  readonly key: string;
  readonly label: string;
  readonly tokens: number;
}
interface BreakdownSection {
  readonly key: string;
  readonly label: string;
  readonly tokens: number;
  readonly rows: readonly BreakdownRow[];
}

/** 扁平化后的待渲染行——层级用 depth 表达，模板因此只留一个 v-for，
 *  不必在 section / server / 工具之间嵌四层 template。 */
interface VisibleRow extends BreakdownChild {
  readonly note?: string;
  readonly depth: 0 | 1;
  readonly expandable: boolean;
  readonly expanded: boolean;
}

/** 折叠键的主键是**身份**（来源名）而不是位置：行序每次 context_usage 事件都按占用
 *  重排，纯位置键会让"已展开的那一行"换到别的实体上（面板开着时新事件一到就错位）。
 *  索引是无条件追加的重名兜底：平铺行不持有折叠状态，键随重排变化只是让 v-for 重挂
 *  无状态子树，无实害；真正有状态的 MCP 组行索引恒为 0，键等价于纯身份。 */
function rowKey(prefix: string, identity: string, index: number): string {
  return `${prefix}:${identity}:${index}`;
}

function namedRows(items: readonly ContextUsageNamedItem[], prefix: string): BreakdownRow[] {
  return sortByTokensDesc(items).map((item, i) => ({
    key: rowKey(prefix, item.name, i),
    label: item.name,
    tokens: item.tokens,
  }));
}

const sections = computed<BreakdownSection[]>(() => {
  const b = props.breakdown;
  const out: BreakdownSection[] = [];
  const add = (key: string, label: string, rows: readonly BreakdownRow[]): void => {
    if (rows.length > 0) out.push({ key, label, tokens: sumTokens(rows), rows });
  };

  // server 已按 serverName 归组（Map 键天然唯一）；工具名在 server 内唯一。
  add(
    "mcpTools",
    "MCP 工具",
    groupMcpByServer(b.mcpTools ?? []).map((server) => ({
      key: rowKey("mcpTools", server.serverName, 0),
      label: server.serverName,
      tokens: server.tokens,
      children: server.tools.map((tool) => ({
        key: `mcpTools:${server.serverName}:${tool.name}`,
        label: tool.name,
        tokens: tool.tokens,
      })),
    })),
  );
  add("systemTools", "内置工具", namedRows(b.systemTools ?? [], "systemTools"));
  add(
    "deferredBuiltinTools",
    "延迟加载工具",
    namedRows(b.deferredBuiltinTools ?? [], "deferredBuiltinTools"),
  );
  add(
    "systemPromptSections",
    "系统提示分区",
    namedRows(b.systemPromptSections ?? [], "systemPromptSections"),
  );
  // 记忆文件/子代理的 type 与 source 是 provider 自报标签（不透明，不由本端解释），
  // 只当尾注原样显示——和分类名同样的处理。
  add(
    "memoryFiles",
    "记忆文件",
    sortByTokensDesc(b.memoryFiles ?? []).map((f, i) => ({
      key: rowKey("memoryFiles", f.path, i),
      label: f.path,
      note: f.type,
      tokens: f.tokens,
    })),
  );
  add(
    "agents",
    "子代理",
    sortByTokensDesc(b.agents ?? []).map((a, i) => ({
      key: rowKey("agents", a.agentType, i),
      label: a.agentType,
      note: a.source,
      tokens: a.tokens,
    })),
  );
  return out;
});

/** 展开态：section 键集合 + 组行键集合。不可变替换（沿用 ChangeLogPanel/SearchPanel
 *  的 Set 折叠范式），组件自持——父面板重开即重置。 */
const openSections = ref<ReadonlySet<string>>(new Set());
const openGroups = ref<ReadonlySet<string>>(new Set());

function toggle(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(set);
  if (!next.delete(key)) next.add(key);
  return next;
}

function toggleSection(key: string): void {
  openSections.value = toggle(openSections.value, key);
}

function toggleGroup(key: string): void {
  openGroups.value = toggle(openGroups.value, key);
}

function isSectionOpen(key: string): boolean {
  return openSections.value.has(key);
}

/** 按当前展开态把 section 的行展平（含展开出来的子行）。 */
function visibleRows(sectionKey: string): VisibleRow[] {
  const section = sections.value.find((s) => s.key === sectionKey);
  if (!section) return [];
  const out: VisibleRow[] = [];
  for (const row of section.rows) {
    if (!row.children) {
      out.push({ ...row, depth: 0, expandable: false, expanded: false });
      continue;
    }
    const expanded = openGroups.value.has(row.key);
    out.push({ key: row.key, label: row.label, tokens: row.tokens, depth: 0, expandable: true, expanded });
    if (expanded) {
      for (const child of row.children) {
        out.push({ ...child, depth: 1, expandable: false, expanded: false });
      }
    }
  }
  return out;
}
</script>

<template>
  <div class="usage-breakdown" v-if="sections.length">
    <div class="usage-breakdown__title">占用来源</div>
    <div class="usage-breakdown__scroll">
      <div class="usage-breakdown__section" v-for="s in sections" :key="s.key">
        <button
          type="button"
          class="usage-breakdown__row usage-breakdown__row--head"
          :aria-expanded="isSectionOpen(s.key)"
          @click="toggleSection(s.key)"
        >
          <span class="usage-breakdown__caret">{{ isSectionOpen(s.key) ? "▾" : "▸" }}</span>
          <span class="usage-breakdown__label">{{ s.label }}</span>
          <span class="usage-breakdown__value">{{ formatTokens(s.tokens) }}</span>
        </button>

        <div class="usage-breakdown__body" v-if="isSectionOpen(s.key)">
          <template v-for="row in visibleRows(s.key)" :key="row.key">
            <button
              v-if="row.expandable"
              type="button"
              class="usage-breakdown__row"
              :class="`usage-breakdown__row--d${row.depth}`"
              :aria-expanded="row.expanded"
              :title="row.label"
              @click="toggleGroup(row.key)"
            >
              <span class="usage-breakdown__caret">{{ row.expanded ? "▾" : "▸" }}</span>
              <span class="usage-breakdown__label">{{ row.label }}</span>
              <span class="usage-breakdown__value">{{ formatTokens(row.tokens) }}</span>
            </button>
            <div
              v-else
              class="usage-breakdown__row"
              :class="`usage-breakdown__row--d${row.depth}`"
              :title="row.label"
            >
              <span class="usage-breakdown__label">{{ row.label }}</span>
              <span v-if="row.note" class="usage-breakdown__note">{{ row.note }}</span>
              <span class="usage-breakdown__value">{{ formatTokens(row.tokens) }}</span>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.usage-breakdown {
  margin-bottom: 12px;
}

.usage-breakdown__title {
  font-size: 12px;
  color: var(--aide-text-muted);
  margin-bottom: 6px;
}

/* 限高滚动：封顶展开带来的高度增幅（面板高度只在打开时量过一次）。用 vh 夹一层，
 * 小窗口下不至于把可展开区撑到比视口还高。 */
.usage-breakdown__scroll {
  max-height: min(180px, 40vh);
  overflow-y: auto;
}

.usage-breakdown__section + .usage-breakdown__section {
  margin-top: 2px;
}

.usage-breakdown__row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 3px 4px;
  border: none;
  background: none;
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  border-radius: var(--aide-radius-sm);
  transition: background var(--aide-ease-t);
}

button.usage-breakdown__row {
  cursor: pointer;
}

button.usage-breakdown__row:hover {
  background: var(--aide-surface-hover);
}

/* 子行缩进：1px 引导线与既有折叠列表同款（ChangeRoundItem / SubagentCallBlock）。 */
.usage-breakdown__row--d1 {
  margin-left: 13px;
  padding-left: 8px;
  border-left: 1px solid var(--aide-border);
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}

.usage-breakdown__body {
  padding-bottom: 4px;
}

/* 三角 caret：全项目文本三角统一 14px（见 PermissionDialog / BgTaskDock）。 */
.usage-breakdown__caret {
  font-size: 14px;
  line-height: 1;
  color: var(--aide-text-muted);
  flex-shrink: 0;
}

.usage-breakdown__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--aide-text-primary);
}

.usage-breakdown__note {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--aide-text-muted);
}

.usage-breakdown__value {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--aide-text-muted);
  font-variant-numeric: tabular-nums;
}
</style>
