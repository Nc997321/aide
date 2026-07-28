<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { usePermissions } from "@/composables/usePermissions";
import { useModal } from "@/composables/useModal";
import { useToast } from "@/composables/useToast";
import type { PermissionRule, PermissionRuleDraft, PermissionScope } from "@/types/permissions";
import PermissionScopeTabs from "./permissions/PermissionScopeTabs.vue";
import PermissionRuleList from "./permissions/PermissionRuleList.vue";
import PermissionRuleEditor from "./permissions/PermissionRuleEditor.vue";
import PermissionDecisionPanel from "./permissions/PermissionDecisionPanel.vue";

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

onMounted(() => {
  perms.load().catch((e) => showToast("加载权限失败：" + String(e), "danger"));
});

async function openEditor(title: string) {
  let submitted = await modal.custom<PermissionRuleDraft | null>({
    title,
    component: PermissionRuleEditor,
    props: { initial: perms.draft.rule },
  });
  while (submitted) {
    perms.draft.rule = submitted;
    try {
      await perms.saveDraft();
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
    await perms.deleteRule(rule.id);
    showToast("规则已删除", "success");
  } catch (e) {
    showToast("删除失败：" + String(e), "danger");
  }
}
</script>

<template>
  <div class="permissions-settings">
    <div class="content-head">
      <div>
        <h1>工具权限</h1>
        <p class="subtext">为 Aide 内的工具调用设置预先允许、每次询问或拒绝规则。</p>
      </div>
      <button v-if="canAddRule" class="primary-btn" @click="onAdd">＋ 添加规则</button>
    </div>

    <PermissionScopeTabs
      v-if="perms.scopes.value.length"
      :scopes="perms.scopes.value"
      v-model="activeScope"
    />

    <div v-if="currentScope" class="scope-summary">
      <span class="badge">{{ currentScope.description }}</span>
      <span v-if="currentScope.storagePath">
        写入 <code>{{ currentScope.storagePath }}</code>。
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
</template>

<style scoped>
.permissions-settings { display: grid; gap: 0; }
.content-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
}
h1 { margin: 0; font-size: 16px; color: var(--aide-text-primary); }
.subtext { margin: 4px 0 0; color: var(--aide-text-muted); font-size: 12px; }
.primary-btn {
  height: 31px;
  padding: 0 14px;
  border: 1px solid color-mix(in srgb, var(--aide-accent) 55%, var(--aide-border));
  background: var(--aide-accent-gradient);
  color: var(--aide-text-on-accent);
  border-radius: var(--aide-radius-md);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.scope-summary {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 14px;
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
}
.scope-summary .reason { color: var(--aide-warning); }
.priority-note {
  margin-top: 14px;
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