<script setup lang="ts">
import { ref, onMounted } from "vue";
import DirTreePicker from "../../DirTreePicker.vue";
import { api } from "../../../api";
import { useWorkspaces } from "../../../composables/useWorkspaces";
import { useOnboarding } from "../../../composables/useOnboarding";

const emit = defineEmits<{ selected: [path: string] }>();

const ob = useOnboarding();
const { activeKey, openFolder } = useWorkspaces();
// DirTreePicker 的 model 类型是 string | string[]（multiple=false 时为 string）
const path = ref<string | string[]>("");
const busy = ref(false);
const error = ref("");
const hasPath = ref(false);

// DirTreePicker 通过 update:modelValue 写入 path；同时维护一个布尔以便按钮禁用态
function onPick(v: string | string[]) {
  path.value = v;
  hasPath.value = (Array.isArray(v) ? v[0] : v)?.trim().length > 0;
}

// 已有工作区则自动跳过：activeKey（openFolder 设过）或 getProjectInfo().root（启动时已加载的实际工作区）。
// activeKey 启动时不从 values.workspace 恢复（一直 null），故补 getProjectInfo 检查——老用户才真正跳过此步。
onMounted(async () => {
  if (activeKey.value) { ob.advance(); return; }
  try {
    const info = await api.getProjectInfo();
    if (info?.root) ob.advance();
  } catch {
    // 无工作区则留在本步让用户选
  }
});

async function confirm() {
  const p = (Array.isArray(path.value) ? path.value[0] : path.value ?? "").trim();
  if (!p) { error.value = "请选择一个文件夹"; return; }
  busy.value = true; error.value = "";
  try {
    await openFolder(p);   // createWorkspace + refresh + 设激活 key
    emit("selected", p);   // App 侧 onSidebarWsChanged 走完整加载（文件树/run 配置/JDK）
    ob.advance();
  } catch (e: any) {
    error.value = typeof e === "string" ? e : (e?.message ?? "打开目录失败");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="eyebrow">02 / 04 · 工作区</div>
  <div class="headline">选一个文件夹开始</div>
  <div class="support">文件树、代码索引、运行配置都基于工作区。选一个项目文件夹——之后随时能换。</div>
  <div class="picker-card">
    <div class="picker-tree">
      <DirTreePicker :model-value="path" @update:model-value="onPick" />
    </div>
    <div v-if="error" class="err">{{ error }}</div>
    <button class="confirm-btn" :disabled="busy || !hasPath" @click="confirm">
      {{ busy ? "打开中…" : "打开并切换" }}
    </button>
  </div>
</template>

<style scoped>
.eyebrow {
  font-size: 10px; color: var(--aide-accent); font-weight: 600;
  letter-spacing: .14em; text-transform: uppercase;
}
.headline {
  font-size: 24px; font-weight: 600; letter-spacing: -.015em; color: var(--aide-text-primary);
}
.support {
  font-size: 13px; color: var(--aide-text-secondary); line-height: 1.65; max-width: 440px;
}
.picker-card {
  width: 100%; max-width: 480px;
  background: var(--aide-bg-deep); border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md); box-shadow: var(--aide-highlight-inset);
  padding: 12px; display: flex; flex-direction: column; gap: 10px;
}
.picker-tree { max-height: 280px; overflow: auto; border-radius: var(--aide-radius-sm); }
.err { font-size: 11.5px; color: var(--aide-danger); }
.confirm-btn {
  width: 100%; padding: 10px 16px; border-radius: var(--aide-radius-md);
  background: var(--aide-accent-gradient); color: #eef0ff; font-size: 13px; font-weight: 600;
  box-shadow: var(--aide-accent-glow), var(--aide-highlight-inset);
  border: 1px solid rgba(150,170,255,.45); cursor: pointer;
  transition: all .16s var(--aide-ease);
}
.confirm-btn:disabled { opacity: .5; cursor: not-allowed; }
.confirm-btn:not(:disabled):hover { filter: brightness(1.07); transform: translateY(-1px); }
@media (prefers-reduced-motion: reduce) { .confirm-btn { transition: none; } .confirm-btn:not(:disabled):hover { transform: none; } }
</style>