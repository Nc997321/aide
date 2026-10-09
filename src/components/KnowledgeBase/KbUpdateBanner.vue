<script setup lang="ts">
// 知识库面板顶部的「有新版本 / 服务端太旧」横幅。说什么由 updateBanner.ts 决定，
// 本组件只负责说成人话、给出可复制的命令。只告知，不执行升级。
import { ref } from "vue";
import type { UpdateBanner } from "./updateBanner";

defineProps<{ banner: UpdateBanner }>();
const emit = defineEmits<{ dismiss: [version: string] }>();

const copied = ref(false);
async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    copied.value = false; // 命令框是 user-select: all，点一下也能全选带走
  }
}
</script>

<template>
  <div v-if="banner.kind === 'upgrade'" class="kb-update" data-kb-update>
    <span class="kb-update-text">
      <template v-if="banner.latest">
        知识库服务有新版本 <b>{{ banner.latest }}</b>（当前 {{ banner.current ?? "旧版本" }}）。
      </template>
      <template v-else>知识库服务是 <b>{{ banner.current ?? "旧版本" }}</b>。</template>
      <template v-if="banner.required">这个客户端需要更新的服务端才能正常使用。</template>
      <template v-if="banner.isAdmin">在服务器上放 docker-compose.yml 的目录里运行：</template>
      <template v-else>请联系知识库管理员，在服务器上放 docker-compose.yml 的目录里运行：</template>
      <small>命令会把目标版本写进 .env（覆盖里面旧的 KB_IMAGE），只重启知识库服务，不动数据库和数据。</small>
    </span>
    <code class="kb-update-cmd">{{ banner.command }}</code>
    <button class="kb-update-link" @click="copy(banner.command)">{{ copied ? "已复制" : "复制命令" }}</button>
    <button
      v-if="!banner.required && banner.latest"
      class="kb-update-link"
      @click="emit('dismiss', banner.latest)"
    >
      以后再说
    </button>
  </div>
</template>

<style scoped>
.kb-update {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
  padding: 10px 20px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--aide-text-secondary);
  background: var(--aide-accent-subtle);
  flex: none;
}
/* 说明独占一行，命令 + 按钮在下一行——挤在一行时命令会被面板边缘切掉 */
.kb-update-text { flex: 1 1 100%; min-width: 0; }
.kb-update-text b { font-weight: 600; color: var(--aide-text-primary); }
.kb-update-text small { display: block; color: var(--aide-text-muted); }
.kb-update-cmd {
  flex: 0 1 auto;
  min-width: 0;
  padding: 2px 8px;
  border-radius: var(--aide-radius-sm);
  background: var(--aide-surface-default);
  font-family: var(--aide-font-mono);
  font-size: 11.5px;
  color: var(--aide-text-primary);
  overflow-wrap: anywhere; /* 窄面板下折行，不溢出 */
  user-select: all; /* 复制按钮失效时，点一下能全选带走 */
}
.kb-update-link {
  border: none;
  background: none;
  padding: 2px 0;
  font: inherit;
  font-size: 11.5px;
  color: var(--aide-text-muted);
  cursor: pointer;
  transition: color var(--aide-ease-t);
}
.kb-update-link:hover { color: var(--aide-text-primary); }
</style>
