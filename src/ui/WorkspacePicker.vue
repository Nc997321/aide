<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useWorkspaces } from "../composables/useWorkspaces";
import { dailyWorkspaceBind, ensureDailyWorkspace, workspaceDisplayName } from "@aide/sdk/utils/dailyWorkspace";
import type { WorkspaceInfo } from "../types";

/**
 * 工作区选择下拉（共享组件，双消费方）。
 *
 * 只发射选中结果，不改任何全局状态——**选归属 ≠ 切工作区**，选中后由调用方
 * 决定写哪：
 * - hero「新会话位于 X」（VariantMorning）：写入空白 tab 的 pendingWs / 零 tab
 *   布局的 defaultWs，不切全局；
 * - 文件树 path-bar（FileTree）：上抛 switch-workspace，由侧栏执行真正切换。
 *
 * 列表消费 useWorkspaces 模块级单例（与侧栏同源，展开时 refresh 顺带刷新共享
 * 状态，其他消费方免费受益）；组件不自持第二份列表状态。
 *
 * 触发按钮默认内置行内形态；异形按钮（如 path-bar 的全宽形态）走 #trigger
 * slot，slot props：open（开合态，供 chevron 旋转）/ toggle（开合切换）/
 * label（path 的 basename）。浮层配色走标准浮层配方（bg-raised +
 * surface-blur + border-strong + shadow-lg），毛玻璃/实底由主题 token 区分；
 * 下拉 Teleport 到 body + fixed 定位（ThemedSelect 同款 positionMenu），blur
 * 采样直达文档根，不被宿主毛玻璃容器的嵌套 Backdrop Root 吃掉。
 */
const props = defineProps<{
  /** 当前归属的工作区根路径（勾选高亮依据）；空串时按钮显示「未选择」 */
  path: string;
  /** 列表顶上多一项固定的「日常」（日常目录不在工作区列表里）。只给「切换活动工作区」的
   *  消费方开（文件树）；hero 选归属不开——那里日常/工程由模式切换决定。 */
  includeDaily?: boolean;
}>();
const emit = defineEmits<{
  select: [ws: WorkspaceInfo];
}>();

const open = ref(false);
const loading = ref(false);
const { workspaces: list, refresh: refreshWorkspaces } = useWorkspaces();
const rootRef = ref<HTMLElement | null>(null);
/** Teleport 到 body 的下拉面板引用与定位态 */
const menuRef = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({});
const positioned = ref(false);

/** 日常那一项；没开 includeDaily 或归属还没装载时为 null。 */
const daily = ref<WorkspaceInfo | null>(null);
async function loadDaily() {
  if (!props.includeDaily || !(await ensureDailyWorkspace())) return;
  const bind = dailyWorkspaceBind();
  daily.value = bind ? { key: bind.wsKey, name: bind.wsPath, missing: false } : null;
}
onMounted(() => void loadDaily());

const label = computed(() => {
  if (!props.path) return "未选择工作区";
  // daily 进依赖：装载完成后「日常」的名字要跟着出来
  return daily.value?.name === props.path ? "日常" : workspaceDisplayName(props.path);
});

function toggle() {
  if (open.value) {
    open.value = false;
    return;
  }
  open.value = true;
  loading.value = true;
  // 每次展开经统一状态层重拉（与原直调语义一致）：refresh 内部 catch 收窄为
  // 空列表——轻量选择器不值得为拉取失败弹错，降级为空态「无其它工作区」，
  // 重开下拉即重试；成功侧顺带刷新共享列表，侧栏等其他消费方同步受益。
  // 不 await：开合是同步 UI 动作，加载态由 loading 呈现（refresh 不会 reject）。
  void refreshWorkspaces().finally(() => { loading.value = false; });
}

function pick(ws: WorkspaceInfo) {
  open.value = false;
  if (ws.missing) return;
  emit("select", ws);
}

/** 翻转决策的假定高度：开时菜单只有加载行（~30px），列表加载后长到 CSS
 *  max-height——按上限假定，两方向定位一次到位且无加载后跳变 */
const MENU_MAX_H = 260;

/** 触发容器视口矩形 → Teleport 下拉的 fixed 坐标：下翻/上翻 + 横向钳制。
 *  手法与 ThemedSelect.positionMenu 同款；Teleport 使 blur 采样直达文档根，
 *  绕开嵌套 Backdrop Root（毛玻璃容器）吃掉内层 backdrop-filter 的问题。 */
async function positionMenu() {
  const anchor = rootRef.value;
  if (!anchor) return;
  await nextTick();
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const spaceBelow = window.innerHeight - rect.bottom;
  const openUp = spaceBelow < MENU_MAX_H + margin && rect.top > spaceBelow;
  // 上翻用 bottom 锚定底边：短菜单贴触发器，长菜单向上生长（≤max-height 不溢出）
  const vPos: Record<string, string> = openUp
    ? { bottom: `${window.innerHeight - rect.top + 4}px`, top: "auto" }
    : { top: `${rect.bottom + 4}px` };

  const menuWidth = menuRef.value?.offsetWidth || rect.width;
  let left = rect.left;
  if (left + menuWidth > window.innerWidth - margin) {
    left = window.innerWidth - menuWidth - margin;
  }

  menuStyle.value = {
    ...vPos,
    left: `${Math.max(margin, left)}px`,
  };
  positioned.value = true;
}

const dropdownStyle = computed(() => ({
  ...menuStyle.value,
  visibility: positioned.value ? ("visible" as const) : ("hidden" as const),
}));

function onClickOutside(e: MouseEvent) {
  // target 非 Node（边缘场景）按根外处理：contains(null) 为 false，关下拉语义不变
  const target = e.target instanceof Node ? e.target : null;
  const insideAnchor = rootRef.value?.contains(target) ?? false;
  // Teleport 后面板在 body 下，须并入判定域，否则点选项被误判根外先关
  const insideMenu = menuRef.value?.contains(target) ?? false;
  if (!insideAnchor && !insideMenu) open.value = false;
}
onMounted(() => document.addEventListener("click", onClickOutside));
onUnmounted(() => document.removeEventListener("click", onClickOutside));

/** Esc 关闭（开着才监听）。preventDefault 消费：与 ThemedSelect 同款让路约定——
 *  下拉开着时按 Esc 只关下拉，不同时触发外层（如权限弹窗）的 Esc 负面动作。 */
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && open.value) {
    e.preventDefault();
    open.value = false;
  }
}
watch(open, (v) => {
  if (v) {
    positioned.value = false;
    void positionMenu();
    document.addEventListener("keydown", onKeydown);
    window.addEventListener("resize", positionMenu);
  } else {
    document.removeEventListener("keydown", onKeydown);
    window.removeEventListener("resize", positionMenu);
  }
});
onUnmounted(() => {
  document.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", positionMenu);
});
</script>

<template>
  <div ref="rootRef" class="workspace-picker">
    <slot name="trigger" :open="open" :toggle="toggle" :label="label">
      <button class="wp-trigger" v-tooltip="props.path || '未选择工作区'" @click.stop="toggle">
        <svg class="wp-folder" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        <span class="wp-name">{{ label }}</span>
        <svg class="wp-chevron" :class="{ open }" width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2.5 3.5L5 6L7.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </slot>
    <Teleport to="body">
      <div v-if="open" ref="menuRef" class="wp-dropdown" :style="dropdownStyle">
        <div v-if="loading" class="wp-status">加载中…</div>
        <template v-else>
          <button
            v-if="daily"
            class="wp-option"
            :class="{ active: daily.name === props.path }"
            v-tooltip="daily.name"
            @click="pick(daily)"
          >
            <span class="wp-option-name">日常</span>
            <span v-if="daily.name === props.path" class="wp-option-check">✓</span>
          </button>
          <button
            v-for="ws in list"
            :key="ws.key"
            class="wp-option"
            :class="{ active: ws.name === props.path, missing: ws.missing }"
            :disabled="ws.missing"
            v-tooltip="ws.missing ? '路径已失效' : ws.name"
            @click="pick(ws)"
          >
            <span class="wp-option-name">{{ ws.name.split(/[\\/]/).filter(Boolean).pop() || ws.name }}</span>
            <span v-if="ws.name === props.path" class="wp-option-check">✓</span>
          </button>
          <div v-if="list.length === 0 && !daily" class="wp-status">无其它工作区</div>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style>
.workspace-picker {
  position: relative;
  display: inline-flex;
}

.wp-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  margin: -1px -2px;
  border: none;
  border-radius: var(--aide-radius-sm);
  background: transparent;
  color: var(--aide-text-primary);
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
  transition: all var(--aide-ease-t);
}

.wp-trigger:hover {
  color: var(--aide-accent);
  background: var(--aide-surface-hover);
}

.wp-trigger:active {
  background: var(--aide-accent-subtle);
}

.wp-folder {
  color: var(--aide-accent);
  flex-shrink: 0;
}

.wp-name {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wp-chevron {
  color: var(--aide-text-muted);
  flex-shrink: 0;
  transition: transform var(--aide-ease-t);
}

.wp-chevron.open {
  transform: rotate(180deg);
}

/* Teleport 到 body + fixed 定位（坐标走内联 dropdownStyle）：毛玻璃 blur 采样
   直达文档根，不受宿主容器（sidebar-left 等 Backdrop Root）嵌套影响 */
.wp-dropdown {
  position: fixed;
  z-index: 9000;
  min-width: 200px;
  max-width: 320px;
  max-height: 260px;
  overflow-y: auto;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-lg);
  box-shadow: var(--aide-shadow-lg);
  /* 标准浮层配方：毛玻璃主题给 blur，实底主题 surface-blur 为 "none" 无害 */
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
  padding: 5px;
}

.wp-option {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: var(--aide-radius-sm);
  background: transparent;
  color: var(--aide-text-secondary);
  font-family: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  transition: all var(--aide-ease-t);
}

.wp-option:hover:not(:disabled) {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}

.wp-option.active {
  color: var(--aide-text-primary);
}

.wp-option.active .wp-option-check {
  color: var(--aide-accent);
}

.wp-option.missing {
  opacity: 0.5;
  cursor: not-allowed;
}

.wp-option-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wp-option-check {
  flex-shrink: 0;
  font-size: 12px;
}

.wp-status {
  padding: 8px 10px;
  font-size: 12.5px;
  color: var(--aide-text-muted);
  text-align: center;
}
</style>