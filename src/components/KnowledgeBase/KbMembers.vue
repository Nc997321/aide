<script setup lang="ts">
// 成员管理（仅管理员可见）。
//
// 邀请制的核心界面：管理员填用户名 → 生成一次性链接 → 发给同事。
// 明文令牌只在生成那一次返回，服务端只存哈希，所以**关掉这个框就再也拿不回来**，
// 界面上明确写出来，免得管理员以为还能翻历史。
import { computed, ref, watch } from "vue";
import Icon from "@/components/Icon.vue";
import {
  inviteLink,
  type KbInvite,
  type KbSpace,
  type KbUserRow,
} from "./kbClient";

const props = defineProps<{
  users: KbUserRow[];
  spaces: KbSpace[];
  busy: boolean;
  error: string | null;
  currentUserId: string | null;
  /** 父组件刚生成出来的邀请。用 prop 而不是方法回调，状态只有一个来源。 */
  lastInvite: KbInvite | null;
  /** 父组件刚创建成功的空间，变化时清空创建表单（与 lastInvite 同一模式）。 */
  lastCreatedSpace: KbSpace | null;
}>();

const emit = defineEmits<{
  invite: [username: string, displayName: string, isAdmin: boolean, spaceId: string | null, spaceRole: string | null];
  revoke: [id: string];
  refresh: [];
  createSpace: [key: string, name: string, visibility: "private" | "internal" | "public"];
}>();

const username = ref("");
const displayName = ref("");
const isAdmin = ref(false);
const spaceId = ref<string>("");
const spaceRole = ref<string>("viewer");

const copied = ref(false);

// ── 创建空间 ──
// 后端对 key 的约束（spaces.rs validate_key）：2~40 位，小写字母/数字/连字符。
// 这里不重复校验长度，交给服务端报错——但输入时顺手转小写，少一次往返失败。
const spaceKey = ref("");
const spaceName = ref("");
const spaceVisibility = ref<"private" | "internal" | "public">("internal");

const canCreateSpace = computed(
  () =>
    spaceKey.value.trim() !== "" &&
    spaceName.value.trim() !== "" &&
    !props.busy,
);

function onCreateSpace(): void {
  if (!canCreateSpace.value) return;
  emit(
    "createSpace",
    spaceKey.value.trim().toLowerCase(),
    spaceName.value.trim(),
    spaceVisibility.value,
  );
  // 成功与否由父层反馈：成功会更新 lastCreatedSpace（下方 watch 清空表单），
  // 失败只显示错误、保留输入，改完直接再点
}

// 父组件每次成功生成邀请都会换一个新的 lastInvite 对象，
// 这里跟着刷新"刚生成的链接"区域并把表单清掉。
watch(
  () => props.lastInvite,
  (inv) => {
    if (!inv) return;
    copied.value = false;
    username.value = "";
    displayName.value = "";
    isAdmin.value = false;
  },
);

watch(
  () => props.lastCreatedSpace,
  (s) => {
    if (!s) return;
    spaceKey.value = "";
    spaceName.value = "";
    spaceVisibility.value = "internal";
  },
);

const canInvite = computed(
  () => username.value.trim() !== "" && displayName.value.trim() !== "" && !props.busy,
);

function onSubmit(): void {
  if (!canInvite.value) return;
  emit(
    "invite",
    username.value.trim(),
    displayName.value.trim(),
    isAdmin.value,
    spaceId.value || null,
    spaceId.value ? spaceRole.value : null,
  );
}

async function copyLink(): Promise<void> {
  if (!props.lastInvite) return;
  const link = inviteLink(props.lastInvite.token);
  try {
    await navigator.clipboard.writeText(link);
    copied.value = true;
  } catch {
    // 剪贴板不可用（权限被拒 / 非安全上下文）：把输入框选中让用户自己复制
    const el = document.getElementById("kb-invite-link") as HTMLInputElement | null;
    el?.select();
  }
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
</script>

<template>
  <div class="kb-members">
    <section class="kb-block">
      <h3>创建空间</h3>
      <div class="kb-form">
        <input
          v-model="spaceKey"
          type="text"
          placeholder="标识（小写字母/数字/-，如 eng-handbook）"
          class="kb-key-input"
          spellcheck="false"
        />
        <input v-model="spaceName" type="text" placeholder="空间名称" />
        <select v-model="spaceVisibility">
          <option value="private">私有（仅成员可见）</option>
          <option value="internal">内部（登录可见）</option>
          <option value="public">公开（所有人可读）</option>
        </select>
        <button class="kb-primary" :disabled="!canCreateSpace" @click="onCreateSpace">
          创建
        </button>
      </div>
    </section>

    <section class="kb-block">
      <h3>邀请新成员</h3>
      <div class="kb-form">
        <input v-model="username" type="text" placeholder="用户名（登录用）" />
        <input v-model="displayName" type="text" placeholder="昵称（显示用）" />
        <select v-model="spaceId">
          <option value="">不加入空间</option>
          <option v-for="s in props.spaces" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
        <select v-if="spaceId" v-model="spaceRole">
          <option value="viewer">只读</option>
          <option value="editor">可编辑</option>
          <option value="admin">空间管理员</option>
        </select>
        <label class="kb-check">
          <input v-model="isAdmin" type="checkbox" />
          <span>同时设为全局管理员</span>
        </label>
        <button class="kb-primary" :disabled="!canInvite" @click="onSubmit">生成邀请链接</button>
      </div>

      <div v-if="props.lastInvite" class="kb-created">
        <p class="kb-hint">
          ⚠️ 链接只显示这一次，服务端只存哈希。关掉就看不到了，需要就重新生成。
        </p>
        <div class="kb-linkrow">
          <input
            id="kb-invite-link"
            :value="inviteLink(props.lastInvite.token)"
            readonly
            @focus="($event.target as HTMLInputElement).select()"
          />
          <button class="kb-primary" @click="copyLink()">{{ copied ? "已复制" : "复制" }}</button>
        </div>
        <small>{{ props.lastInvite.username }} · 有效期至 {{ fmtTime(props.lastInvite.expiresAt) }}</small>
      </div>
    </section>

    <section class="kb-block grow">
      <div class="kb-block-head">
        <h3>成员（{{ props.users.length }}）</h3>
        <button class="kb-link" :disabled="props.busy" @click="emit('refresh')">
          <Icon name="refresh" :size="12" :stroke-width="1.4" />
        </button>
      </div>
      <p v-if="props.error" class="kb-err">{{ props.error }}</p>

      <table class="kb-table">
        <tbody>
          <tr v-for="u in props.users" :key="u.id">
            <td class="kb-uname">
              {{ u.displayName }}
              <small>{{ u.username }}</small>
            </td>
            <td class="kb-tag">
              <span v-if="u.isAdmin" class="kb-badge">管理员</span>
              <span v-if="!u.isActive" class="kb-badge off">已停用</span>
            </td>
            <td class="kb-seen">{{ fmtTime(u.lastSeenAt) }}</td>
            <td class="kb-act">
              <button
                v-if="u.isActive && u.id !== props.currentUserId"
                class="kb-link danger"
                @click="emit('revoke', u.id)"
              >
                停用
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="props.users.length === 0" class="kb-none">还没有成员</p>
    </section>
  </div>
</template>

<style scoped>
.kb-members {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 18px 20px;
  overflow: auto;
}
.kb-block {
  border: 1px solid var(--aide-border);
  border-radius: 10px;
  padding: 14px;
}
.kb-block.grow { flex: 1; min-height: 0; overflow: auto; }
.kb-block h3 {
  margin: 0 0 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--aide-text-primary);
}
.kb-block-head { display: flex; align-items: center; justify-content: space-between; }
.kb-block-head h3 { margin-bottom: 10px; }
.kb-form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.kb-form input[type="text"],
.kb-form select {
  padding: 6px 8px;
  font-size: 12px;
  color: var(--aide-text-primary);
  background: var(--aide-bg-primary);
  border: 1px solid var(--aide-border);
  border-radius: 6px;
  outline: none;
}
.kb-key-input {
  font-family: var(--aide-font-mono, ui-monospace, monospace);
  width: 240px;
}
.kb-check {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--aide-text-muted);
}
.kb-primary {
  padding: 6px 12px;
  font-size: 12px;
  color: #fff;
  background: var(--aide-accent);
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.kb-primary:disabled { opacity: 0.6; cursor: default; }
.kb-created {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--aide-border);
}
.kb-hint {
  margin: 0 0 8px;
  font-size: 11px;
  color: var(--aide-text-muted);
  line-height: 1.6;
}
.kb-linkrow { display: flex; gap: 6px; }
.kb-linkrow input {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  font-size: 11px;
  font-family: var(--aide-font-mono, ui-monospace, monospace);
  color: var(--aide-text-primary);
  background: var(--aide-bg-primary);
  border: 1px solid var(--aide-border);
  border-radius: 6px;
  outline: none;
}
.kb-created small { font-size: 10px; color: var(--aide-text-muted); }
.kb-table { width: 100%; border-collapse: collapse; }
.kb-table td {
  padding: 6px 4px;
  font-size: 12px;
  border-bottom: 1px solid var(--aide-border);
  vertical-align: middle;
}
.kb-uname { color: var(--aide-text-primary); }
.kb-uname small { display: block; font-size: 10px; color: var(--aide-text-muted); }
.kb-tag { width: 92px; }
.kb-badge {
  display: inline-block;
  padding: 1px 6px;
  font-size: 10px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--aide-accent) 18%, transparent);
  color: var(--aide-text-primary);
}
.kb-badge.off {
  background: color-mix(in srgb, var(--aide-error, #d0453b) 16%, transparent);
}
.kb-seen { width: 84px; font-size: 10px; color: var(--aide-text-muted); }
.kb-act { width: 48px; text-align: right; }
.kb-link {
  border: none;
  background: none;
  padding: 0;
  font-size: 11px;
  color: var(--aide-accent);
  cursor: pointer;
  display: inline-flex;
}
.kb-link.danger { color: var(--aide-error, #d0453b); }
.kb-err { margin: 0 0 8px; font-size: 11px; color: var(--aide-error, #d0453b); }
.kb-none { font-size: 11px; color: var(--aide-text-muted); }
</style>
