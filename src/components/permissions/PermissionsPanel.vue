<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { usePermissions } from "@/composables/usePermissions";
import { useModal } from "@/composables/useModal";
import { useToast } from "@/composables/useToast";
import type { PermissionRule, PermissionRuleDraft, PermissionScope } from "@/types/permissions";
import PermissionScopeTabs from "./PermissionScopeTabs.vue";
import PermissionRuleList from "./PermissionRuleList.vue";
import PermissionRuleEditor from "./PermissionRuleEditor.vue";
import PermissionDecisionPanel from "./PermissionDecisionPanel.vue";

const props = defineProps<{ workspacePath?: string }>();
/** 空串（未打开工作区）→ undefined → Rust 当前活动工作区兜底 */
const project = computed(() => props.workspacePath || undefined);

const perms = usePermissions();
const modal = useModal();
const { showToast } = useToast();

const activeScope = ref<PermissionScope>("user");

const currentScope = computed(
  () => perms.scopes.value.find((s) => s.scope === activeScope.value),
);
const rulesForScope = computed(() =>
  perms.rules.value.filter((r) => r.scope === activeScope.value),
);
const canAddRule = computed(
  () => activeScope.value !== "managed" && (currentScope.value?.editable ?? false),
);

// v-show 面板常驻挂载：单一触发点同时覆盖初始加载与切工作区重载
watch(
  project,
  (p) => {
    void perms.load(p).catch((e) => showToast("加载权限失败：" + String(e), "danger"));
  },
  { immediate: true },
);

async function openEditor(title: string) {
  let submitted = await modal.custom<PermissionRuleDraft | null>({
    title,
    component: PermissionRuleEditor,
    props: { initial: perms.draft.rule },
  });
  while (submitted) {
    perms.draft.rule = submitted;
    try {
      await perms.saveDraft(project.value);
      showToast("权限规则已保存", "success");
      return;
    } catch (e) {
      showToast("保存失败：" + String(e), "danger");
      // Re-open the same draft so the user can retry without losing input.
      submitted = await modal.custom<PermissionRuleDraft | null>({
        title,
        component: PermissionRuleEditor,
        props: { initial: perms.draft.rule },
      });
    }
  }
}

function onAdd() {
  perms.beginCreate(activeScope.value);
  void openEditor("新建权限规则");
}

function onEdit(rule: PermissionRule) {
  perms.beginEdit(rule);
  void openEditor("编辑权限规则");
}

async function onDelete(rule: PermissionRule) {
  const ok = await modal.confirm("删除规则", `确定删除规则 ${rule.tool}？`, "删除", true);
  if (!ok) return;
  try {
    await perms.deleteRule(rule.id, project.value);
    showToast("规则已删除", "success");
  } catch (e) {
    showToast("删除失败：" + String(e), "danger");
  }
}
</script>

<template>
  <div class="permissions-panel">
    <div class="panel-header">
      <span class="panel-title">工具权限</span>
      <button v-if="canAddRule" class="primary-btn" @click="onAdd">＋ 添加规则</button>
    </div>

    <div class="permissions-scroll">
      <PermissionScopeTabs
        v-if="perms.scopes.value.length"
        :scopes="perms.scopes.value"
        v-model="activeScope"
      />

      <div v-if="currentScope" class="scope-summary">
        <span class="badge">{{ currentScope.description }}</span>
        <span v-if="currentScope.storagePath">
          <code>{{ currentScope.storagePath }}</code>。
        </span>
        <span v-if="!currentScope.editable" class="reason">{{ currentScope.reason }}</span>
      </div>

      <PermissionRuleList
        :rules="rulesForScope"
        :scope="currentScope ?? { scope: activeScope, editable: false, reason: '尚未打开项目', storagePath: null, description: '' }"
        @edit="onEdit"
        @delete="onDelete"
      />

      <div class="priority-note">
        <strong>优先级</strong>
        <span>受管策略 → 用户全局 → 项目共享 → 项目本地 → 本会话。上层的拒绝规则不能被下层放宽。</span>
      </div>

      <PermissionDecisionPanel />
    </div>
  </div>
</template>

<style scoped>
.permissions-panel {
  display: flex;
  flex-direction: column;
  position: relative;
  height: 100%;
  background: var(--aide-bg-deep);
  overflow: hidden;
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
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
.primary-btn {
  flex-shrink: 0;
  height: 26px;
  padding: 0 10px;
  border: 1px solid color-mix(in srgb, var(--aide-accent) 55%, var(--aide-border));
  background: var(--aide-accent-gradient);
  color: var(--aide-text-on-accent);
  border-radius: var(--aide-radius-md);
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}
.permissions-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
}
.permissions-scroll::-webkit-scrollbar { width: 4px; }
.permissions-scroll::-webkit-scrollbar-track { background: transparent; }
.permissions-scroll::-webkit-scrollbar-thumb { background: var(--aide-surface-hover); border-radius: 2px; }

.scope-summary {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 10px;
  padding: 9px 11px;
  border: 1px solid color-mix(in srgb, var(--aide-info) 25%, var(--aide-border));
  background: color-mix(in srgb, var(--aide-info) 7%, var(--aide-bg-base));
  border-radius: var(--aide-radius-md);
  color: var(--aide-text-secondary);
  font-size: 12px;
}
.scope-summary .badge { color: var(--aide-info); font-weight: 600; }
.scope-summary code {
  font-family: var(--aide-font-mono, monospace);
  color: var(--aide-text-primary);
  /* 长路径（Windows 盘符无空格）必须能断行，否则撑出面板右缘 */
  min-width: 0;
  word-break: break-all;
}
.scope-summary .reason { color: var(--aide-warning); }
.priority-note {
  margin-top: 10px;
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--aide-warning) 24%, var(--aide-border));
  background: color-mix(in srgb, var(--aide-warning) 7%, var(--aide-bg-base));
  border-radius: var(--aide-radius-md);
  color: var(--aide-text-secondary);
  font-size: 11.5px;
}
.priority-note strong { color: var(--aide-warning); }
</style>
