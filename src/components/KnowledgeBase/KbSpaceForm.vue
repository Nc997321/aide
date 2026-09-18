<script setup lang="ts">
// 新建空间表单。**不是独立弹窗**——它是 `useModal().custom()` 的 contents：
// ModalDialog 负责遮罩、层级、Esc/overlay 关闭，这里只管三个字段与校验，
// 按契约 emit submit(payload) / cancel。
//
// 为什么用对话框而不是侧栏里的浮层：侧栏的段落是 `overflow: auto` 的，绝对定位的
// 浮层会被容器裁掉（实际表现为只露出下半截）。对话框是 Teleport 到 body 的，
// 没有这个问题。
import { computed, ref } from "vue";

const emit = defineEmits<{
  submit: [payload: { key: string; name: string; visibility: "private" | "internal" | "public" }];
  cancel: [];
}>();

const key = ref("");
const name = ref("");
const visibility = ref<"private" | "internal" | "public">("internal");

/**
 * 标识的合法性，与后端 `spaces.rs::validate_key` 同规则。
 *
 * **只为省一次必然失败的往返**，服务端仍是唯一权威——规则若哪天变了，
 * 这里不同步的后果只是「客户端放过去、服务端 400」，不是数据损坏。
 */
const KEY_RE = /^[a-z0-9-]{2,40}$/;

// ⚠️ 校验看的是 **trim 后**的值：从文档里复制标识常带首尾空格，直接拿原值判会让
//    按钮一直灰着，而用户看不出为什么（提交时本来就要 trim，两边口径必须一致）。
const canSubmit = computed(() => KEY_RE.test(key.value.trim()) && name.value.trim() !== "");

function onSubmit(): void {
  if (!canSubmit.value) return;
  emit("submit", {
    key: key.value.trim(),
    name: name.value.trim(),
    visibility: visibility.value,
  });
}

// 输入框挂载即聚焦
const vFocus = {
  mounted: (el: HTMLElement) => (el as HTMLInputElement).focus(),
};
</script>

<template>
  <div data-space-form class="kb-form">
    <label>
      标识<span class="kb-form-hint">小写字母 / 数字 / -，建后不可改</span>
      <input v-model="key" data-space-key v-focus spellcheck="false" placeholder="eng-handbook" />
    </label>
    <label>
      名称
      <input v-model="name" data-space-name placeholder="工程手册" @keydown.enter="onSubmit" />
    </label>
    <label>
      可见性
      <select v-model="visibility" data-space-visibility>
        <option value="private">私有（仅成员可见）</option>
        <option value="internal">内部（登录可见）</option>
        <option value="public">公开（所有人可读）</option>
      </select>
    </label>

    <div class="kb-form-actions">
      <button class="kb-btn" type="button" @click="emit('cancel')">取消</button>
      <button class="kb-btn primary" data-space-submit type="button" :disabled="!canSubmit" @click="onSubmit">
        创建
      </button>
    </div>
  </div>
</template>

<style scoped>
.kb-form { display: flex; flex-direction: column; gap: 12px; }
.kb-form label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
  color: var(--aide-text-secondary);
}
.kb-form-hint { font-size: 11px; color: var(--aide-text-muted); margin-left: 6px; }
.kb-form input,
.kb-form select {
  padding: 6px 8px;
  font: inherit;
  font-size: 12px;
  color: var(--aide-text-primary);
  background: var(--aide-bg-primary);
  border: 1px solid var(--aide-border);
  border-radius: 6px;
  outline: none;
}
.kb-form input:focus,
.kb-form select:focus { border-color: var(--aide-accent); }
.kb-form-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.kb-btn {
  padding: 6px 12px;
  font: inherit;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid var(--aide-border);
  background: none;
  color: var(--aide-text-secondary);
  cursor: pointer;
}
.kb-btn:hover { background: var(--aide-surface-hover); color: var(--aide-text-primary); }
.kb-btn.primary {
  border-color: transparent;
  background: var(--aide-accent);
  color: var(--aide-text-on-accent);
  font-weight: 500;
}
.kb-btn.primary:disabled { opacity: 0.45; cursor: default; }
</style>
