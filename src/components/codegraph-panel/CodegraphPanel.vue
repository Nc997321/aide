<script setup lang="ts">
// 右侧栏「代码索引」面板（工作区级开关下沉后的唯一开关 UI）。
//
// 职责：
// - 当前工作区的索引开关（读 enabledForRoot 缓存 + 写走门面 setRootEnabled）；
// - 「更新索引（仅改动文件）/ 全量重建索引」两个操作按钮（自文件树右键菜单迁入）；
// - 索引健康展示（lastBuild + lastBuildRoot 按工作区归属，自 SettingsPanel 迁入）；
// - 尾部嵌 Embedding 后端配置（CodegraphEmbedderConfig，全局配置不受开关隐藏——配置是提前填的）。
//
// 状态权威在后端（state.json），本组件只读门面的响应式缓存（enabledForRoot）；
// 切工作区/挂载时 refreshEnabledFor 权威拉取。开关 off 时操作按钮禁用。
import { computed, watch } from "vue";
import { useCodeGraphProgress } from "../../composables/useCodeGraphProgress";
import { AButton, ABadge } from "../../ui";
import CodegraphEmbedderConfig from "./CodegraphEmbedderConfig.vue";

const props = defineProps<{ workspaceRoot: string }>();

const cg = useCodeGraphProgress();

// 当前工作区开关（读门面缓存；权威拉取在 ensureIndex / refreshEnabledFor）
const rootEnabled = computed(() => !!cg.enabledForRoot.value[props.workspaceRoot]);

// 挂载/切工作区时权威拉取（缓存可能过时；面板只在右侧栏可见，拉取廉价）
watch(
  () => props.workspaceRoot,
  (root) => {
    if (root) void cg.refreshEnabledFor(root);
  },
  { immediate: true },
);

async function onToggleChange(e: Event) {
  const checked = (e.target as HTMLInputElement).checked;
  // 门面统一联动：落盘 + 刷缓存 + 开→清守卫并 ensureIndex（未信任走既有通知流）、
  // 关→释放该 root 活跃索引。失败时刷新缓存回真实状态。
  try {
    await cg.setRootEnabled(props.workspaceRoot, checked);
  } finally {
    if (props.workspaceRoot) void cg.refreshEnabledFor(props.workspaceRoot);
  }
}

const canMaintain = computed(
  () => !!props.workspaceRoot && rootEnabled.value && !cg.building.value,
);

function updateIndex() {
  void cg.rescan(props.workspaceRoot);
}

function rebuildIndex() {
  cg.rebuild(props.workspaceRoot);
}

// 索引健康：lastBuild 按归属 root 过滤——上一个工作区的健康状态不给当前工作区看。
// kind → ABadge color（success/warning/danger），文案原样。
const health = computed<{ color: "success" | "warning" | "danger"; text: string } | null>(() => {
  const r = cg.lastBuild.value;
  if (!r || cg.lastBuildRoot.value !== props.workspaceRoot) return null;
  const sym = r.total_symbols ?? 0;
  switch (r.health) {
    case "complete": return { color: "success", text: `完整 · ${sym} 符号` };
    case "degraded": return { color: "warning", text: `残缺 · ${sym} indexed, ${r.skipped_count ?? 0} skipped, ${r.failed_count ?? 0} failed` };
    case "incomplete": return { color: "danger", text: `未完成，恢复中（${r.embed_status ?? "—"}）` };
    case "structure_only": return { color: "danger", text: `语义不可用 · embedder 缺失` };
    default: return { color: "success", text: `已索引 · ${sym} 符号` };
  }
});
</script>

<template>
  <div class="cg-panel">
    <!-- 面板壳：同 PermissionsPanel 的 panel-header + 滚动内容区结构 -->
    <div class="panel-header">
      <span class="panel-title">代码索引</span>
    </div>

    <div class="cg-scroll">
      <div v-if="!workspaceRoot" class="cg-info">
        <span class="field-hint">未选择工作区。代码索引按工作区开关：打开一个项目后在此启用。</span>
      </div>

      <template v-else>
        <!-- 开关：每工作区独立（state.json），默认关。标签+开关一行，说明文字整行换行 -->
        <div class="settings-field">
          <div class="toggle-row">
            <span class="field-label">索引开关</span>
            <label class="toggle">
              <input type="checkbox" :checked="rootEnabled" @change="onToggleChange" />
              <span class="toggle-track"></span>
            </label>
          </div>
          <span class="field-hint">
            {{ rootEnabled
              ? '索引开启：项目加载、文件变更、会话结束都会更新索引'
              : '当前工作区未开启代码索引（每工作区独立，默认关）' }}
          </span>
        </div>

        <!-- 索引维护：更新/全量重建（自右键菜单迁入），off 时禁用。窄侧栏纵向堆叠 -->
        <div class="cg-action-row">
          <AButton
            class="cg-action-btn"
            variant="primary"
            size="sm"
            :disabled="!canMaintain"
            title="只 reindex mtime 变动的文件（通常几秒）"
            @click="updateIndex"
          >
            更新索引（仅改动文件）
          </AButton>
          <AButton
            class="cg-action-btn"
            size="sm"
            :disabled="!canMaintain"
            title="跳过快速路径从零重建，怀疑索引损坏时用"
            @click="rebuildIndex"
          >
            全量重建索引
          </AButton>
        </div>

        <!-- 关闭态说明（开态下这里显示构建进度的职责由文件树底部进度条承担） -->
        <div v-if="!rootEnabled" class="cg-info">
          <span class="field-hint">
            代码索引已关闭：启动、文件变更、保存都不会扫描或加载索引。重新打开后对当前工作区立即构建。
          </span>
        </div>

        <!-- 索引健康（上次成功构建的结果，按工作区归属） -->
        <div v-else-if="health" class="cg-info">
          <ABadge :value="health.text" :color="health.color" />
        </div>
      </template>

      <!-- Embedding 后端配置：全局机器配置，不受开关态隐藏（配置是提前填的） -->
      <CodegraphEmbedderConfig />
    </div>
  </div>
</template>

<style scoped>
/* ===== 面板壳：同 PermissionsPanel 结构 ===== */
.cg-panel {
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
  overflow: hidden;
  text-overflow: ellipsis;
}

.cg-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
}
.cg-scroll::-webkit-scrollbar { width: 4px; }
.cg-scroll::-webkit-scrollbar-track { background: transparent; }
.cg-scroll::-webkit-scrollbar-thumb { background: var(--aide-surface-hover); border-radius: 2px; }

/* ===== 开关行 ===== */
.settings-field {
  margin-bottom: 14px;
}

.field-label {
  display: block;
  font-size: 13px;
  color: var(--aide-text-primary);
  font-weight: 500;
}

.field-hint {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--aide-text-muted);
}

.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.toggle {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  cursor: pointer;
  flex-shrink: 0;
}

.toggle input {
  opacity: 0;
  width: 0;
  height: 0;
  position: absolute;
}

.toggle-track {
  position: absolute;
  inset: 0;
  background: var(--aide-surface-hover);
  border-radius: 10px;
  transition: background 0.15s;
}

.toggle-track::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: var(--aide-text-primary);
  border-radius: 50%;
  transition: transform 0.15s;
}

.toggle input:checked + .toggle-track {
  /* 开关是 accentGradient 槽位的既定消费场景 */
  background: var(--aide-accent-gradient);
}

.toggle input:checked + .toggle-track::after {
  transform: translateX(16px);
  background: var(--aide-text-on-accent);
  transition: transform 0.15s, background 0.15s;
}

/* ===== 维护操作：窄侧栏纵向堆叠，宽度铺满 ===== */
.cg-action-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
}

.cg-action-btn {
  width: 100%;
}

.cg-info {
  margin-bottom: 14px;
}
</style>
