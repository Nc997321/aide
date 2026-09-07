<script setup lang="ts">
/**
 * 知识库主区视图（第一版：可读可搜）。
 * 与 MemoryObservatory 同范式——填满主区的一级视图，不是模态。
 * 数据闭包见 useKnowledgeBase，通道见 kbClient（直连 knowledge-server REST）。
 *
 * 第一版不做：编辑保存、版本回滚、编辑锁、文件上传导入。
 */
import { computed, onMounted, ref, watch } from "vue";
import Icon from "@/components/Icon.vue";
import { useKnowledgeBase } from "@/composables/useKnowledgeBase";
import KbWelcome from "./KbWelcome.vue";
import KbLogin from "./KbLogin.vue";
import KbDocumentView from "./KbDocumentView.vue";
import KbSearchView from "./KbSearchView.vue";
import KbMembers from "./KbMembers.vue";

const emit = defineEmits<{ close: [] }>();

const k = useKnowledgeBase();
const activeDocId = ref<string | null>(null);

/** 视图分流：探测中 → welcome（KbWelcome 首屏）↔ form（KbLogin 表单）→ main（已登录）。
 *  main 由 k.user 非空条件渲染（demoMode 时 user=DEMO_USER，自动落 main）。
 *  welcome ↔ form 切换只影响未登录用户的下一站：表单可「← 返回」回 welcome。 */
const view = ref<"welcome" | "form">("welcome");
const formMode = ref<"login" | "join">("login");

function enterForm(mode: "login" | "join"): void {
  formMode.value = mode;
  view.value = "form";
}
function backToWelcome(): void {
  view.value = "welcome";
}

// 「文档 / 成员」二态——与 view 分流是两套轴，互不干扰。
const innerView = ref<"doc" | "members">("doc");

const isAdmin = computed(() => k.user.value?.isAdmin === true);

// 进入成员页时拉一次名单；非管理员不会看到入口，这里再兜一层防止直接切。
watch(innerView, (v) => {
  if (v === "members" && isAdmin.value) void k.loadUsers();
});

/** 文档树的层级：沿 parentId 往上数，最多 3 层（再深也按 3 缩进，避免长链）。
 *  后端返回的是扁平列表，树是下一批的事，这里只做视觉缩进。 */
const depthOf = computed<Record<string, number>>(() => {
  const byId = new Map(k.documents.value.map((d) => [d.id, d]));
  const out: Record<string, number> = {};
  for (const d of k.documents.value) {
    let depth = 0;
    let cur = d.parentId ? byId.get(d.parentId) : undefined;
    while (cur && depth < 3) {
      depth++;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    out[d.id] = depth;
  }
  return out;
});

const activeSpaceName = computed(
  () => k.spaces.value.find((s) => s.id === k.activeSpaceId.value)?.name ?? "",
);

// 正在编辑的文档 id。openDoc 切换前检查它，避免编辑中的草稿被侧栏一次点击冲掉
// （编辑内容本身在 KbDocumentView 里，组件卸载即丢——所以要在卸载前问一句）。
const editingDocId = ref<string | null>(null);

async function openDoc(id: string): Promise<void> {
  if (editingDocId.value && editingDocId.value !== id) {
    if (!window.confirm("正在编辑的文档尚未完成，切换将丢弃未保存的修改。确认切换？")) {
      return;
    }
    // 用户确认放弃：KbDocumentView 卸载时 onScopeDispose 会释放编辑锁
    editingDocId.value = null;
  }
  activeDocId.value = id;
  k.clearSearch();
  await k.openDocument(id);
}

/** 保存/回滚后刷新正文与侧栏（侧栏要反映新的 versionNo 与 updatedAt）。
 *  保存请求进行期间用户可能已切走文档——那时只刷列表，不把用户拉回来。 */
async function refreshDoc(id: string): Promise<void> {
  const spaceId = k.activeSpaceId.value;
  if (activeDocId.value === id) await k.openDocument(id);
  if (spaceId) await k.loadDocuments(spaceId);
}

function onEditing(on: boolean): void {
  editingDocId.value = on ? activeDocId.value : null;
}

async function onCreateSpace(
  key: string,
  name: string,
  visibility: "private" | "internal" | "public",
): Promise<void> {
  await k.createSpace({ key, name, visibility });
}

// 搜索防抖：中文输入每敲一个字都发请求既浪费又会让结果闪烁
let searchTimer: ReturnType<typeof setTimeout> | null = null;
function onQueryInput(v: string): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void k.search(v), 250);
}

onMounted(() => k.init());
</script>

<template>
  <div class="kb-panel">
    <header class="kb-head">
      <!-- GLYPHS 里没有 book；知识库本质是文档集合，用 file -->
      <span class="kb-logo"><Icon name="file" :size="14" /></span>
      <h1>知识库</h1>

      <div v-if="k.user.value" class="kb-searchbox">
        <Icon name="search" :size="12" :stroke-width="1.4" />
        <input
          :value="k.query.value"
          placeholder="检索文档…"
          @input="onQueryInput(($event.target as HTMLInputElement).value)"
        />
        <button v-if="k.query.value" class="kb-clearq" @click="k.clearSearch()">
          <Icon name="close" :size="11" :stroke-width="1.4" />
        </button>
      </div>

      <span class="kb-spacer" />

      <button
        v-if="k.user.value"
        class="kb-iconbtn"
        v-tooltip="'刷新'"
        :disabled="k.loading.value"
        @click="k.loadSpaces()"
      >
        <Icon name="refresh" :size="13" :stroke-width="1.4" />
      </button>
      <button class="kb-iconbtn" v-tooltip="'关闭'" @click="emit('close')">
        <Icon name="close" :size="13" :stroke-width="1.4" />
      </button>
    </header>

    <!-- 探测中：先不出登录框，否则每次开面板都会闪一下表单再切换 -->
    <div v-if="!k.ready.value" class="kb-empty"><p>连接知识库服务…</p></div>

    <!-- 第一屏：welcome / form 二选一。
         main（已登录）由 k.user 非空条件渲染，demoMode 下 user=DEMO_USER 自动落 main。 -->
    <KbWelcome
      v-else-if="!k.user.value && view === 'welcome'"
      :busy="k.loading.value"
      :error="k.error.value"
      :initialized="k.initialized.value"
      @join="enterForm('join')"
      @login="enterForm('login')"
      @setup="view = 'form'"
      @demo="k.enterDemo()"
      @retry="() => {
        k.init();
      }"
    />

    <KbLogin
      v-else-if="!k.user.value"
      :busy="k.loading.value"
      :error="k.error.value"
      :initialized="k.initialized.value"
      :prefer-mode="formMode"
      @setup="
        (u, n, p, e) => {
          void k.setup(u, n, p, e);
        }
      "
      @login="
        (a, p) => {
          void k.login(a, p);
        }
      "
      @join="
        (t) => {
          void k.join(t);
        }
      "
      @cancel="backToWelcome()"
    />

    <template v-else>
      <div class="kb-body">
        <aside class="kb-side">
          <div class="kb-sidesec">
            <div class="kb-sec-title">空间</div>
            <button
              v-for="s in k.spaces.value"
              :key="s.id"
              class="kb-space"
              :class="{ on: s.id === k.activeSpaceId.value }"
              @click="k.selectSpace(s.id)"
            >
              <span class="kb-space-name">{{ s.name }}</span>
              <span class="kb-space-role">{{ s.role ?? "—" }}</span>
            </button>
            <p v-if="k.spaces.value.length === 0" class="kb-none">还没有可见的空间</p>
          </div>

          <div class="kb-sidesec grow">
            <div class="kb-sec-title">文档</div>
            <button
              v-for="d in k.documents.value"
              :key="d.id"
              class="kb-docitem"
              :class="{ on: d.id === activeDocId }"
              :style="{ paddingLeft: `${8 + depthOf[d.id] * 12}px` }"
              @click="openDoc(d.id)"
            >
              {{ d.title }}
            </button>
            <p v-if="k.documents.value.length === 0" class="kb-none">这个空间还没有文档</p>
          </div>

          <div class="kb-user">
            <span class="kb-user-name">{{ k.user.value.displayName }}</span>
            <button
              v-if="isAdmin"
              class="kb-link"
              @click="innerView = innerView === 'members' ? 'doc' : 'members'"
            >
              {{ innerView === "members" ? "返回文档" : "成员" }}
            </button>
            <button class="kb-link" @click="k.logout()">退出</button>
          </div>
        </aside>

        <main class="kb-main">
          <p v-if="k.error.value" class="kb-err">{{ k.error.value }}</p>

          <KbMembers
            v-if="innerView === 'members' && isAdmin"
            :users="k.users.value"
            :spaces="k.spaces.value"
            :busy="k.loading.value"
            :error="null"
            :current-user-id="k.user.value.id"
            :last-invite="k.lastInvite.value"
            :last-created-space="k.lastCreatedSpace.value"
            @invite="
              (u, n, a, sid, role) => {
                void k.invite({ username: u, displayName: n, isAdmin: a, spaceId: sid, spaceRole: role });
              }
            "
            @revoke="
              (id) => {
                void k.revokeUser(id);
              }
            "
            @create-space="
              (key, name, vis) => {
                void onCreateSpace(key, name, vis);
              }
            "
            @refresh="k.loadUsers()"
          />
          <KbSearchView
            v-else-if="k.searchResult.value || k.searching.value"
            :result="k.searchResult.value"
            :busy="k.searching.value"
            @open="(id) => openDoc(id)"
          />
          <KbDocumentView
            v-else-if="k.activeDoc.value"
            :doc="k.activeDoc.value"
            :editable="!k.demoMode.value"
            @saved="(id) => refreshDoc(id)"
            @reverted="(id) => refreshDoc(id)"
            @editing="onEditing"
          />
          <div v-else class="kb-empty">
            <p>从左侧选一篇文档</p>
            <small>{{ activeSpaceName || "知识库" }}</small>
          </div>
        </main>
      </div>
    </template>
  </div>
</template>

<style scoped>
.kb-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.kb-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 20px 12px;
}
.kb-logo { color: var(--aide-accent); display: inline-flex; }
.kb-head h1 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--aide-text-primary);
}
.kb-spacer { flex: 1; }

.kb-searchbox {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 8px;
  padding: 3px 8px;
  border: 1px solid var(--aide-border);
  border-radius: 999px;
  color: var(--aide-text-muted);
}
.kb-searchbox input {
  width: 190px;
  border: none;
  background: none;
  outline: none;
  font-size: 12px;
  color: var(--aide-text-primary);
}
.kb-clearq,
.kb-iconbtn {
  display: inline-flex;
  border: none;
  background: none;
  padding: 2px;
  color: var(--aide-text-muted);
  cursor: pointer;
}
.kb-iconbtn:hover { color: var(--aide-text-primary); }
.kb-iconbtn:disabled { opacity: 0.5; cursor: default; }

.kb-body {
  flex: 1;
  display: flex;
  min-height: 0;
  border-top: 1px solid var(--aide-border);
}

.kb-side {
  width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--aide-border);
  overflow: hidden;
}
.kb-sidesec {
  padding: 10px 8px;
  border-bottom: 1px solid var(--aide-border);
  overflow: auto;
}
.kb-sidesec.grow { flex: 1; border-bottom: none; }
.kb-sec-title {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--aide-text-muted);
  padding: 0 6px 6px;
}
.kb-space,
.kb-docitem {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: none;
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--aide-text-secondary, var(--aide-text-muted));
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-space:hover,
.kb-docitem:hover { background: var(--aide-bg-deep); }
.kb-space.on,
.kb-docitem.on {
  background: color-mix(in srgb, var(--aide-accent) 16%, transparent);
  color: var(--aide-text-primary);
}
.kb-space { display: flex; justify-content: space-between; gap: 6px; }
.kb-space-role { font-size: 10px; opacity: 0.6; }

.kb-none {
  margin: 4px 6px;
  font-size: 11px;
  color: var(--aide-text-muted);
}

.kb-user {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 8px 12px;
  border-top: 1px solid var(--aide-border);
  font-size: 11px;
  color: var(--aide-text-muted);
}
.kb-user-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-link {
  border: none;
  background: none;
  padding: 0;
  font-size: 11px;
  color: var(--aide-accent);
  cursor: pointer;
}

.kb-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.kb-err {
  margin: 0;
  padding: 8px 20px;
  font-size: 11px;
  color: var(--aide-error, #d0453b);
  background: color-mix(in srgb, var(--aide-error, #d0453b) 10%, transparent);
}
.kb-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: var(--aide-text-muted);
}
.kb-empty p { margin: 0; font-size: 12px; }
.kb-empty small { font-size: 11px; opacity: 0.7; }
</style>
