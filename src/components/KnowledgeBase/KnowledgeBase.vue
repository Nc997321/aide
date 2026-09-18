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
import KbLogin from "./KbLogin.vue";
import KbGuide from "./KbGuide.vue";
import KbDocumentView from "./KbDocumentView.vue";
import KbSearchView from "./KbSearchView.vue";
import KbMembers from "./KbMembers.vue";
import KbSpaceList from "./KbSpaceList.vue";
import { depthOf as depthOfMap, subtreeSize } from "./docTree";

const emit = defineEmits<{ close: [] }>();

const k = useKnowledgeBase();
const activeDocId = ref<string | null>(null);
/** 空间段的「+」在父层模板里（分组标题旁），所以只能这样够到它的 startCreate */
const spaceRef = ref<InstanceType<typeof KbSpaceList> | null>(null);

// 视图分流只有一条轴：登录与否。未登录直接是 KbLogin 表单（模式由服务端
// initialized 决定：空库 → 创建管理员，否则 → 口令登录/邀请链接），
// 登录成功 k.user 非空即落主界面。没有营销首屏，没有「先看看长什么样」。

// 「文档 / 成员」二态——与 view 分流是两套轴，互不干扰。
const innerView = ref<"doc" | "members">("doc");

const isAdmin = computed(() => k.user.value?.isAdmin === true);

// ── 内置指南 ──
// 登录进来主区默认是《使用指南》（一篇随应用打包的真文档，见 KbGuide.vue）——
// 空库、没选文档时看到的不是空白，而是产品本来的样子。点任何文档或搜索
// 都会离开指南；侧栏的「使用指南」条目随时回来。
const showGuide = ref(true);

function openGuide(): void {
  activeDocId.value = null;
  k.clearSearch();
  showGuide.value = true;
}

// 进入成员页时拉一次名单；非管理员不会看到入口，这里再兜一层防止直接切。
watch(innerView, (v) => {
  if (v === "members" && isAdmin.value) void k.loadUsers();
});

/** 文档树的层级（沿 parentId 往上数，最多 3 层）。树的算法都在 ./docTree，
 *  与删除确认弹窗算的子树篇数共用同一份实现。 */
const depthOf = computed<Record<string, number>>(() => depthOfMap(k.documents.value));

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
  showGuide.value = false;
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

/**
 * 删除（软删；服务端把子文档一并删掉）。
 *
 * 确认弹窗放在**父层**而不是按钮旁边：只有这里手里有整份文档列表，「会连带删掉几篇」
 * 才算得出来（与侧栏缩进共用 ./docTree）。篇数点明是必要的——用户点的是
 * 一篇文档，实际消失的可能是一棵树。
 *
 * 不做「已删除」的成功提示：那一行从侧栏消失、正文区回落空态，本身就是回执。
 */
async function onDeleteDoc(id: string): Promise<void> {
  const title = k.documents.value.find((d) => d.id === id)?.title ?? id;
  const total = subtreeSize(k.documents.value, id);
  const subs = total > 1 ? `，连同 ${total - 1} 篇子文档` : "";
  const ok = window.confirm(
    `删除「${title}」${subs}？\n删除后它不再出现在任何列表、检索与正文，且没有恢复入口。`,
  );
  if (!ok) return;

  // 只有真删掉了才把视图切走：403 / 断网时留在原地，否则用户既丢了阅读位置、
  // 文档又还在（错误提示由 k.error 显示在正文区）
  if (await k.deleteDocument(id)) activeDocId.value = null;
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

    <!-- 未登录：直接是表单。改服务地址失焦后重新探测，空库/已初始化随之切换。 -->
    <KbLogin
      v-else-if="!k.user.value"
      :busy="k.loading.value"
      :error="k.error.value"
      :initialized="k.initialized.value"
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
      @retry="k.init()"
    />

    <template v-else>
      <div class="kb-body">
        <aside class="kb-side">
          <div class="kb-sidesec">
            <div class="kb-sec-title">指南</div>
            <button class="kb-docitem" :class="{ on: showGuide }" @click="openGuide()">
              使用指南
            </button>
          </div>

          <div class="kb-sidesec">
            <div class="kb-sec-title kb-sec-title-row">
              <span>空间</span>
              <!-- 创建本该在这里：埋进成员页之后，建空间得先想到去一个管理员才看得到的入口 -->
              <button class="kb-iconbtn" v-tooltip="'新建空间'" @click="spaceRef?.startCreate()">
                <Icon name="plus" :size="11" />
              </button>
            </div>
            <KbSpaceList
              ref="spaceRef"
              :spaces="k.spaces.value"
              :active-id="k.activeSpaceId.value"
              :busy="k.loading.value"
              @select="(id) => void k.selectSpace(id)"
              @create="
                (key, name, vis) => {
                  void k.createSpace({ key, name, visibility: vis });
                }
              "
              @rename="(id, name) => void k.renameSpace(id, name)"
            />
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
            <!-- 「退出登录」不是「关闭面板」：点了会吊销服务端会话并清本地 token，
                 下次进来必须重新登录。关面板用标题栏的 ×。 -->
            <button class="kb-link" @click="k.logout()">退出登录</button>
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
            :editable="true"
            @saved="(id) => refreshDoc(id)"
            @reverted="(id) => refreshDoc(id)"
            @editing="onEditing"
            @delete="(id) => void onDeleteDoc(id)"
          />
          <!-- 内置指南：登录后的默认主区内容，长得就像一篇文档 -->
          <KbGuide v-else-if="showGuide" />
          <!-- 兜底：文档加载失败等极端情况才会落到这里 -->
          <div v-else class="kb-empty"><p>从左侧选一篇文档</p></div>
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
/* 分组标题带操作按钮时（空间/文档的 +）：标题左、按钮右 */
.kb-sec-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
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
.kb-docitem:hover { background: var(--aide-bg-deep); }
.kb-docitem.on {
  background: color-mix(in srgb, var(--aide-accent) 16%, transparent);
  color: var(--aide-text-primary);
}

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
