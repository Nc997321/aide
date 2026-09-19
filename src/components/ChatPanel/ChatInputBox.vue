<script setup lang="ts">
import { ref, watch, nextTick, computed } from "vue";
import ThemedSelect from "../ThemedSelect.vue";
import ChatSendButton from "../ChatSendButton.vue";
import ContextUsageRing from "./ContextUsageRing.vue";
import ContextUsagePanel from "./ContextUsagePanel.vue";
import AToast from "@/ui/AToast.vue";
import type { SkillMeta, ProviderConfig } from "@/types";
import type {
  ContextUsage, ModelOption, PermissionModeOption, RateLimitInfo, ModelSwitchResult,
} from "@/types/chat";
import type { ImageAttachment, PendingJump, SendOptions } from "@/composables/useChatSession";
import { api } from "@/api";
import { resolvePastePayload } from "@/utils/paste";
import type { PasteResolution } from "@/utils/paste";
import { resolveFileMentions, formatMentionPath, attachedDirsFrom } from "@/utils/fileMentions";
import { useSessionAttachedWorkspaces } from "@/composables/useSessionAttachedWorkspaces";
import { nextPermissionMode } from "@/utils/permissionModeCycle";
import { peekFileClipboard, clearFileClipboard } from "@/composables/useFileClipboard";
import { useInlineMention } from "@/composables/useInlineMention";
import { useMentionInserter } from "@/composables/useMentionInserter";
import { useMentionSuggest, applyPick, type MentionSuggestion } from "@/composables/useMentionSuggest";
import { useWorkspaces } from "@/composables/useWorkspaces";
import { getFileIcon, pathBasename, FOLDER_ICON_PATH } from "@/utils/fileIcons";
import { useQuickActions } from "@/composables/useQuickActions";
import type { QuickAction } from "@/composables/useQuickActions";
import { useModal } from "@/composables/useModal";
import { useBtwSession } from "@/composables/useBtwSession";
import { useSessionIdentityView, writeSessionMeta } from "@/composables/sessionIdentity";
import { isPendingSession, isFinalizedSessionPair } from "@/composables/useChatSession";
import { useToast } from "@/composables/useToast";
import { EFFORT_OPTIONS, normalizeEffortOption } from "@aide/sdk/utils/effort";
import { memoryObservatoryApi } from "@aide/sdk/api";

const props = defineProps<{
  sessionId: string | null;
  workspacePath?: string;
  isBusy: boolean;
  isHero: boolean;
  /** 模型下拉选项（ChatPanel 算好的 displayModels：第三方 provider 真实列表 / 系统默认 SDK 列表） */
  models: ModelOption[];
  currentModel?: string;
  /** 模型切换坐实回执（sidecar 运行时路径发出）——据此弹成功/失败瞬时提示 */
  modelSwitchResult?: ModelSwitchResult | null;
  /** sidecar 坐实的当前 effort（effort_changed 事件）；空串 = 还没学到 */
  currentEffort?: string;
  /** effort 切换失败回执（sidecar 驳回，选择器已被回滚拉回旧值）——据此弹失败提示 */
  effortSwitchError?: { message: string; seq: number } | null;
  permissionModes: PermissionModeOption[];
  currentPermissionMode?: string;
  contextUsage?: ContextUsage | null;
  /** 账号级订阅额度/速率；null 时不显示 */
  rateLimit?: RateLimitInfo | null;
  /** 忙碌时排队、正在 sidecar 里等安全边界的消息（顺序即发出顺序）；jump_promoted 后清空 */
  pendingJumps?: PendingJump[];
  /** 图片 400 回滚后待放回输入框的文本（useChatSession 透传；空串 = 无待回填）。
   *  回填后 emit rollback-text-consumed 清空，避免重复回填。 */
  rollbackText?: string;
  /** 父层恒传（ChatPanel 的 props.focused），非可选 */
  focused: boolean;
  /** 会话所属 provider（effort 档位读取用；模型/身份已归 L2 身份层） */
  sessionProvider: ProviderConfig;
  /** 发送坐实信号：ChatPanel 门控通过/确认后递增，本组件据此清空输入（取消确认
   *  不递增，输入保留——与旧实现「取消时内容回退对话框」语义一致）。 */
  sendConfirmedNonce: number;
}>();

const emit = defineEmits<{
  /** 发送请求（不清输入）：ChatPanel 跑发送前确认门控，通过/确认后 emit send +
   *  递增 sendConfirmedNonce，本组件据此清空输入。 */
  /** 发送请求（不清输入）：effectiveProvider/effectiveModel 并入 opts（ChatPanel
   *  的发送前确认门控据此判定是否弹确认形态），相邻 string 不再位置错位 */
  "send-request": [prompt: string, opts: SendOptions & { effectiveProvider: string; effectiveModel: string }];
  "send-btw": [prompt: string, opts: { model?: string; effort?: string }];
  "set-model": [model: string];
  "set-effort": [effort: string];
  "set-permission-mode": [mode: string];
  /** 图片 400 回滚文本已回填进输入框（父组件据此清空 store.rollbackText） */
  "rollback-text-consumed": [];
  /** hero 头展示的模型名（选中模型变化时上报，ChatPanel 的 hero 标题行用） */
  "hero-model-name": [name: string];
  /** 权限模式变化（用户切换/侧边同步/会话切换）——ChatPanel 的 PermissionDialog
   *  current-mode 展示用（「进入自动模式」按钮的显隐判定）。 */
  "permission-mode-changed": [mode: string];
}>();

const rootEl = ref<HTMLElement | null>(null);
defineExpose({ rootEl });

const identity = useSessionIdentityView();

const displayModels = computed<ModelOption[]>(() => identity.displayModels.value);
const displayPermissionModes = computed<PermissionModeOption[]>(() => props.permissionModes);

// ── 模型选择器 ──
// selectedModel 已归 L2 身份层（identity.effectiveModel，SSOT）。本组件只读它 + 手选走 setUserChoice。
const selectedModel = computed(() => identity.effectiveModel.value);

/** ThemedSelect 需要 {value,label}，把 {value,displayName} 映射过去 */
const modelSelectOptions = computed(() =>
  displayModels.value.map((m) => ({ value: m.value, label: m.displayName })),
);




watch(
  () => props.sessionId,
  async (sid, prevSid) => {
    // 定名搬迁（tempId→realId）：绑定由 finalizeSession.migrateBinding 迁移，这里 currentSid 跟到 realId。
    if (isFinalizedSessionPair(prevSid, sid)) {
      // 定名搬迁：sid 是 realId（非空），isFinalizedSessionPair 不保证 TS 收窄，显式判。
      if (sid) identity.adoptSid(sid);
      return;
    }
    // 无会话 / 新建（pending）会话：清 currentSid——displayModels 走空白面板分支
    // （activeProvider 列表），首次发送 lastIdentity=null 不弹确认。不 resolve
    // （pending 还没身份可恢复）。
    if (!sid || isPendingSession(sid)) {
      identity.clearCurrent();
      return;
    }
    // 读回期间又切走 → focusSession 的 seq 守卫返回 false（本面板已切到别的会话，
    // 结果不该落到这个 sid 上）；切回来时会再走一遍。
    await identity.focusSession(sid);
  },
  { immediate: true },
);
// 模型下拉的 provider 切换重置已归 L2（identity 内部按 provider 归属重算 displayModels/effectiveModel）。

function handleModelChange(value: string) {
  // btw 模式下模型选择器只决定这条支线用什么模型,不回写主会话(主会话模型不变,
  // 发送后 btwMode 关闭,选择器自动回到主会话模型)。
  if (btwMode.value) {
    btwModel.value = value;
    return;
  }
  // 用户手选 → L2 草稿（不落盘；落盘由 model_committed/models_available 的进程坐实事件驱动，见 2026-09-01 设计稿）。
  identity.setUserChoice(value);
  emit("set-model", value);
}

// 模型切换回执 → 瞬时提示：sidecar 运行时坐实（成功 = CLI 已接受；失败 = 被
// 驳回，下拉已被回滚广播拉回旧值）；未启动会话走本地 deferred 回执（无活
// sidecar，选择随下一条消息 initialModel 生效）。此前切换成败在 UI 上完全
// 无法区分。watch seq 而不是整个对象引用：连续两次切同一个模型也要照样弹。
const { toastState, showToast } = useToast();
watch(
  () => props.modelSwitchResult?.seq,
  (seq) => {
    const r = props.modelSwitchResult;
    if (!seq || !r) return;
    // 过期回执不弹：切 tab 离开时 watcher 会随 prop 切换重新触发（seq 从
    // undefined 变回 N），没有这道新鲜度判断，几分钟前切别的会话时的旧提示
    // 会在回到这个 tab 时再弹一遍。
    if (Date.now() - r.at > 5000) return;
    if (r.deferred) {
      showToast(`已选定 ${r.display}，将在发送后生效`, "info");
    } else {
      showToast(
        r.ok ? `模型已切换为 ${r.display}` : `模型切换失败：${r.error ?? "未知原因"}`,
        r.ok ? "success" : "danger",
        r.ok ? undefined : 4200, // 失败原因要读完，留久一点
      );
    }
  },
);

// ── Effort 选择器 ──
// 会话级思考深度：三档制（快速/进阶/极致，@aide/sdk/utils/effort）。默认解析顺序：
// 会话记忆（sessionEffort 元数据）→ provider 配置的 effortLevel → "high"。切换经
// set-effort 走 sidecar applyFlagSettings 即时生效（SDK 官方中途通道，不重启进程、
// 实测不碰 prompt 缓存）；进程没起时选择随下一条消息的 initialEffort（env 通道）带上。
// sidecar 坐实/回滚由 props.currentEffort 同步。**快速(low) 另外会请求关掉思考**，
// 但不是在这里生效的：Rust 侧按档位算出 thinking_enabled（chat.rs 的
// thinking_enabled_for_effort），sidecar 发现该值与当前 query 的 spawn 值漂移时，
// 在下一条 send 原地 resume 重启兑现（session-worker 的 restartQueryForThinking）
// ——所以 effort 是热生效、思考要等下一轮。
//
// ⚠️ 「请求了关闭」≠「端点一定不推理」：CLI 按模型名查本地能力表，对不认识的模型名
// （deepseek-* / 本地 ollama 模型等）**根本不发 thinking 参数**，兼容端点「无该字段
// = 默认开推理」（2026-09-19 实测）。sidecar 已在 cliEnv 注入 CLAUDE_CODE_EXTRA_BODY
// 绕过那份名单，实测有效：deepseek 与本地 ollama 的 /v1/messages 都认 disabled，也都
// 不会因为多这个字段而 400。见 docs/discussions/2026-09-19-thinking-disable-on-third-party-endpoints.md。
const selectedEffort = ref("high");

/** ThemedSelect 的 options 收 mutable 数组；SDK 的 EFFORT_OPTIONS 是 as const
 *  只读常量表（PWA 侧依赖其字面量类型收窄 EffortValue），浅拷贝适配。 */
const effortSelectOptions = [...EFFORT_OPTIONS];
/** 用户在当前会话视图里手动改过 = true——异步恢复/provider 就绪回调不得覆盖。 */
let effortTouchedByUser = false;
/** 上次用户手动切 effort 的时刻——坐实 toast 的新鲜度守卫（仿模型回执的 5s 窗口）。 */
let lastEffortUserActionAt = 0;
/** 已弹过坐实 toast 的档位——同值重复坐实（重连回放开）不重复弹。会话切换时重置。 */
let lastEffortToastValue = "";

/** provider 配置的默认档位（设置面板的 effortLevel 是 LOW/MAX 风格大写）；
 *  没配或非法值 → "high"（用户决定：选择器没有"默认"档，默认就落 high）。
 *  历史 medium/xhigh 值经 normalizeEffortOption 迁移到 进阶/极致。 */
function providerDefaultEffort(): string {
  return normalizeEffortOption(props.sessionProvider.effortLevel);
}

function handleEffortChange(value: string) {
  // btw 模式下 effort 选择器只决定这条支线的档位，不回写主会话（同模型选择器语义）。
  if (btwMode.value) {
    btwEffort.value = value;
    return;
  }
  effortTouchedByUser = true;
  lastEffortUserActionAt = Date.now();
  selectedEffort.value = value;
  // 会话还没开始时 setEffort 是无会话可发的空操作，安全；真正生效靠
  // handleSend 把 selectedEffort 带进第一条消息的 initialEffort。
  emit("set-effort", value);
  // 会话未起：不会有 effort_changed 坐实事件，立即给 deferred 提示（同模型 deferred 文案）。
  if (!props.sessionId) {
    const label = EFFORT_OPTIONS.find((o) => o.value === value)?.label ?? value;
    showToast(`已选定 ${label}，将在发送后生效`, "info");
  }
}

// sidecar 坐实/回滚同步：失败时选择器被拉回旧值（error toast 由下方 watcher 弹）。
// 成功坐实 → toast（镜像模型回执范式）：坐实值 == 用户选定值才弹——失败回滚带
// 的是旧值 ≠ 选定值，天然不弹（失败提示走 effortSwitchError）。比较必须在回滚
// 同步赋值之前。守卫：用户在本视图手动改过（挡初始同步/恢复）+ 5s 新鲜度窗口
// （挡切 tab 回来的旧回执重弹）+ 同值去重。API 回报的历史档位（medium/xhigh）
// 先归一（max 静默降级 xhigh 时选择器仍显示 极致，不落未知档位）。
watch(() => props.currentEffort, (v) => {
  if (!v) return;
  const nv = normalizeEffortOption(v);
  if (
    nv === selectedEffort.value &&
    effortTouchedByUser &&
    Date.now() - lastEffortUserActionAt <= 5000 &&
    nv !== lastEffortToastValue
  ) {
    lastEffortToastValue = nv;
    const label = EFFORT_OPTIONS.find((o) => o.value === nv)?.label ?? nv;
    showToast(
      // 快速档多一句：effort 是热生效的，思考关不关要等下一轮重建 query（见文件头
      // 注释）。**措辞只说"已请求"**——CLI 对不认识的模型名会丢掉 thinking 参数，
      // 兼容端点于是默认开推理（2026-09-19 实测），那时只有显示被隐藏、token 照烧。
      // 说成"已关闭"就是又一次「徽章说假话」。
      nv === "low" ? `${label}已生效 · 已请求关闭思考（下一条消息起）` : `effort 已切换为 ${label}`,
      "success",
    );
  }
  if (nv !== selectedEffort.value) selectedEffort.value = nv;
});

// effort 切换失败 → 瞬时提示（同 modelSwitchResult 的新鲜度守卫语义）。
watch(
  () => props.effortSwitchError?.seq,
  (seq) => {
    if (!seq || !props.effortSwitchError) return;
    showToast(`effort 切换失败：${props.effortSwitchError.message}`, "danger", 4200);
  },
);

// ---- 上下文用量弹层（环形指示的落点与开关，见 ContextUsageRing/Panel）----
// 声明必须在下方 immediate session watch 之前——回调引用 usagePanelOpen，
// 声明滞后会 TDZ（Cannot access before initialization，ChatPanel.test 实锤）。
const usageRingRef = ref<InstanceType<typeof ContextUsageRing> | null>(null);
const usagePanelOpen = ref(false);
const usageRingEl = computed<HTMLElement | null>(
  () => (usageRingRef.value?.$el as HTMLElement | undefined) ?? null,
);

// 会话切换：恢复这个会话记住的 effort（没有则落 provider 默认/high）。
// pending 会话不恢复不重置——选择是用户刚做的/随 initialEffort 走的。
// tempId→realId 定名搬迁同理：同一场会话换名，选择不洗（此前定名时落进下面
// 的 providerDefault 重置，首轮发送后 effort 被洗回默认——首轮 bug 的修复）。
watch(
  () => props.sessionId,
  async (sid, prevSid) => {
    // 用量弹层随会话销毁：面板锚的是旧会话的环形，切走后留在原地只是噪音。
    // 定名搬迁（tempId→realId，同一场会话）不拆面板。
    if (!isFinalizedSessionPair(prevSid, sid)) usagePanelOpen.value = false;
    // 定名搬迁（首轮发送后 SDK 确认真实 id）：不重置不恢复；用户开工前显式
    // 选过的档位随定名持久化进会话元数据（对齐 setEffort 契约，重开会话恢复）。
    if (isFinalizedSessionPair(prevSid, sid)) {
      if (effortTouchedByUser && sid) {
        void writeSessionMeta(sid, { effort: { op: "set", value: selectedEffort.value } }).catch(() => {});
      }
      return;
    }
    if (!sid) {
      effortTouchedByUser = false;
      lastEffortToastValue = "";
      selectedEffort.value = providerDefaultEffort();
      return;
    }
    // pending 临时会话（首轮已发送、等 SDK 定名）：不恢复不重置；touched 保留
    // 到上面的定名分支，用它决定是否把选择持久化。
    if (isPendingSession(sid)) return;
    effortTouchedByUser = false;
    lastEffortToastValue = "";
    // 先按存活会话坐实的 currentEffort 落值，不带上个会话的 selectedEffort（跨会话串）；
    // currentEffort 无效（停止会话/还没学到）时退 provider 默认。再异步恢复 remembered
    // （用户持久化选择优先）——pre-send 选档（pending 时未持久化）靠 currentEffort 兜。
    const ce = props.currentEffort;
    selectedEffort.value = ce ? normalizeEffortOption(ce) : providerDefaultEffort();
    const remembered = await api.sessionEffort(sid).catch(() => null);
    // 读回期间切走了别的会话，或用户已经手动改过 → 放弃恢复
    if (props.sessionId !== sid || effortTouchedByUser) return;
    if (remembered) {
      selectedEffort.value = normalizeEffortOption(remembered);
    }
  },
  { immediate: true },
);

// provider 就绪/切换：只兜底没被用户动过、且不在存活会话里的选择
// （存活会话的 sessionProvider 锁在 spawn 时的 provider，id 不会变，天然跳过）。
watch(() => props.sessionProvider.id, () => {
  if (effortTouchedByUser) return;
  if (props.sessionId && !isPendingSession(props.sessionId)) return;
  selectedEffort.value = providerDefaultEffort();
});

// ── 权限模式（plan / auto / manual）——和模型下拉同一套模式：
// 会话没起进程时用静态兜底清单，用户的选择随每条消息的 permission_mode 带走；
// 进程活着时切换走运行时命令，显示状态靠 sidecar 回发的事件坐实。
const selectedPermissionMode = ref("");

function applyDefaultPermissionMode(modes: PermissionModeOption[]) {
  if (selectedPermissionMode.value || !modes.length) return;
  selectedPermissionMode.value = modes[0].value; // 清单首项即 provider 默认模式
}

watch(() => props.currentPermissionMode, (v) => { if (v) selectedPermissionMode.value = v; });
watch(displayPermissionModes, applyDefaultPermissionMode, { immediate: true });
watch(
  () => props.sessionId,
  (sid, prevSid) => {
    // 定名搬迁：不重置（保留用户 pre-send 选的模式，首条消息 permissionMode 带对）。
    if (isFinalizedSessionPair(prevSid, sid)) return;
    if (!sid) {
      selectedPermissionMode.value = "";
      applyDefaultPermissionMode(displayPermissionModes.value);
      return;
    }
    // pending 会话：保留用户刚选的（无 sidecar 权威源可同步）。
    if (isPendingSession(sid)) return;
    // 每次切换都重置（不带上个会话的模式——跨会话串），再从 sidecar 坐实值或默认落值。
    // currentPermissionMode 同值时 currentPermissionMode watcher 不触发，故此处必须主动落。
    selectedPermissionMode.value = "";
    if (props.currentPermissionMode) selectedPermissionMode.value = props.currentPermissionMode;
    else applyDefaultPermissionMode(displayPermissionModes.value);
  },
  { immediate: true },
);

function handlePermissionModeChange(value: string) {
  selectedPermissionMode.value = value;
  emit("set-permission-mode", value);
  // 用户主动切换（下拉/Shift+Tab）→ 瞬时提示；sidecar 广播同步走
  // currentPermissionMode watcher 不经过这里，不会误弹。
  const label = permissionModeSelectOptions.value.find((o) => o.value === value)?.label ?? value;
  showToast(`权限模式：${label}`, "info");
}

// 权限模式变化上报（ChatPanel 的 PermissionDialog current-mode 展示用）。
watch(selectedPermissionMode, (v) => emit("permission-mode-changed", v), { immediate: true });

/** ThemedSelect 需要 {value,label} */
const permissionModeSelectOptions = computed(() =>
  displayPermissionModes.value.map((m) => ({ value: m.value, label: m.displayName })),
);

// 订阅额度展示：把每个并行窗口折成一个小徽标（已用% + 状态色 + 重置时间）。
// 按已用比例降序（最吃紧的排前面），空则不显示。
const rateLimitWindows = computed(() => {
  const wins = props.rateLimit?.windows ?? [];
  return [...wins]
    .sort((a, b) => b.utilization - a.utilization)
    .map((w) => {
      const pct = Math.round(w.utilization);
      const status = pct >= 100 ? "exceeded" : pct >= 80 ? "warning" : "ok";
      const resetText = formatResetTime(w.resetsAt);
      const parts = [`${w.label} 额度已用 ${pct}%`];
      if (resetText) parts.push(`${resetText}重置`);
      if (status === "exceeded") parts.push("已达上限");
      return { key: w.key, label: w.label, pct, status, title: parts.join(" · ") };
    });
});

/** resetsAt 可能是秒或毫秒的 unix 时间戳——启发式归一到毫秒后折成"还剩 Xh/Xm"。 */
function formatResetTime(resetsAt: number | null): string | null {
  if (typeof resetsAt !== "number" || resetsAt <= 0) return null;
  const ms = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt; // < 1e12 视作秒
  const diff = ms - Date.now();
  if (diff <= 0) return null;
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `约 ${mins} 分钟后`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `约 ${hours} 小时后`;
  return `约 ${Math.round(hours / 24)} 天后`;
}

// ── btw 输入模式 ──
const btwMode = ref(false);
// btw 默认继承主会话当前模型（2026-08-02 改：原默认最便宜的 haiku 系/defaultHaikuModel
// 映射，用户反馈支线回答质量跟不上主会话，索性同源）。btw 期间模型选择器显示它，
// 用户可临时改这条支线的模型（不回写主会话）；发送后 btwMode 关闭，选择器自动回到
// 主会话模型。
const btwModel = ref("");
const btwDefaultModel = computed(() =>
  selectedModel.value || modelSelectOptions.value[0]?.value || "",
);
// btw 期间 effort 选择器落到最低档 low（一次性支线省 token，且 low = 关思考模式，
// 支线不产生思考块）——与模型选择器同形：用户可临时改（只影响这条支线，不回写
// 主会话），发送后 btwMode 关闭，选择器自动回到主会话之前的档位。
const btwEffort = ref("low");
const displayedEffort = computed(() => (btwMode.value ? btwEffort.value : selectedEffort.value));
function toggleBtw() {
  btwMode.value = !btwMode.value;
  if (btwMode.value) {
    btwModel.value = btwDefaultModel.value;
    btwEffort.value = "low";
  }
}
// 输入框模型选择器显示值:btw 期间显示支线模型,否则显示主会话模型
const displayedModel = computed(() => (btwMode.value ? btwModel.value : selectedModel.value));
const btwRevertToast = ref(false);
let btwToastTimer: number | undefined;
function showBtwRevertToast() {
  btwRevertToast.value = true;
  clearTimeout(btwToastTimer);
  btwToastTimer = window.setTimeout(() => (btwRevertToast.value = false), 1600);
}
function playBtwRevertFlash() {
  const box = rootEl.value?.querySelector(".chat-input-box") as HTMLElement | null;
  if (!box) return;
  box.classList.remove("btw-revert-flash");
  void box.offsetWidth; // 重启动画
  box.classList.add("btw-revert-flash");
  setTimeout(() => box.classList.remove("btw-revert-flash"), 800);
}

const btw = useBtwSession();
// 最小化后,支线还在后台跑(starting/running)时浮一个可点开重展抽屉的小标。
// 出错会强制取消最小化(见 useBtwSession error 分支)把错误露出来,所以这里只
// 盖真正在跑的情况;跑完(done)结论已进主对话批注,不再浮。
const btwBgChipVisible = computed(
  () => btw.store.value.minimized
    && btw.store.value.isBusy
    && btw.store.value.ownerSessionId !== null
    && btw.store.value.ownerSessionId === props.sessionId,
);
// 一次性回弹确认:只在支线真正进入 running 才弹"已切回主对话"+flash。
// 失败(error)不弹成功提示,原因在抽屉里展示——修掉"没抽屉却弹已切回"的误导。
const awaitingBtwLaunch = ref(false);
watch(
  () => btw.store.value.status,
  (st) => {
    if (!awaitingBtwLaunch.value) return;
    if (st === "running") {
      awaitingBtwLaunch.value = false;
      playBtwRevertFlash();
      showBtwRevertToast();
    } else if (st === "error") {
      awaitingBtwLaunch.value = false;
    }
  },
);
// 点浮标重展抽屉(最小化的逆操作)。仅清标志、不动进程。
function reopenBtw() { btw.reopen(); }

// ── 输入状态 ──
const inputText = ref("");
const skillList = ref<SkillMeta[]>([]);
const slashDropdownVisible = ref(false);
const slashFilter = ref("");
const slashSelectedIndex = ref(0);

// 图片 400 回滚：sidecar 移除带图消息后把文本放回输入框，用户手动重发。
// 回填后 emit rollback-text-consumed 让父组件清空 store.rollbackText（否则
// 同值不会再次触发 watch，且切会话后旧文本会误回填到新会话输入框）。
watch(
  () => props.rollbackText,
  (text) => {
    if (!text) return;
    inputText.value = text;
    emit("rollback-text-consumed");
  },
);

const filteredSkills = computed(() => {
  if (!slashDropdownVisible.value) return [];
  const q = slashFilter.value.toLowerCase();
  return skillList.value
    .filter((s) => s.name.toLowerCase().includes(q))
    .slice(0, 8);
});
const pendingImages = ref<Array<ImageAttachment & { previewUrl: string }>>([]);
const textareaEl = ref<HTMLTextAreaElement>();

// skills 随工作区变化重扫（onMounted 时 workspacePath 往往还是空串）
watch(
  () => props.workspacePath,
  async (ws) => {
    try {
      skillList.value = await api.scanPluginSkills(ws ?? "");
    } catch {
      skillList.value = [];
    }
  },
  { immediate: true },
);

watch(inputText, (val) => {
  const match = val.match(/^\/(\S*)$/); // / 开头且无空格
  if (match) {
    slashFilter.value = match[1];
    slashDropdownVisible.value = true;
    slashSelectedIndex.value = 0;
    return;
  }
  slashDropdownVisible.value = false;
  // 模式类斜杠命令的即时切换（同一监听点，与斜杠下拉共用）："/btw "（命令名 +
  // 空格）= 点分裂按钮菜单的「顺便问一下」，立即进输入模式并清空，不用等 Enter
  // （"/btw 问题" 的 Enter 直发分发仍在 handleSend）。prompt 类命令（/compact
  // /clear）无输入模式，仍由 Enter 执行。
  const cmd = val.match(/^\/(\S+)\s$/)?.[1];
  const action = cmd ? quickActions.find((a) => a.command === cmd) : undefined;
  if (!btwMode.value && action?.kind === "btw") {
    inputText.value = "";
    toggleBtw();
  }
});

// 切换会话时清空待发图片/引用芯片
// （滚动/窗口复位 + 切入收紧与落位由 useChatScroll 自己 watch sessionId 处理）
//
// 注意:切会话绝不清理 btw 支线——此前这里调 btw.cleanup(),跑中的支线(问答/
// git-commit)直接被 kill,像被"取消"了一样。现在:抽屉可见性由 ownerSessionId
// 绑定(切走自动隐藏、切回重现),sidecar 进程后台照跑,结论经 onDone 回插主会话
// store(模块级,切换不丢)。真正 teardown 只有两处:用户关抽屉(done/error 态)
// / 开新 btw(单实例替换,见 useBtwSession.startBtw)。
watch(() => props.sessionId, () => {
  pendingImages.value = [];
  pendingMentions.value = [];
});

function selectSkill(skill: SkillMeta | undefined) {
  if (!skill) return;
  inputText.value = "/" + skill.name + " ";
  slashDropdownVisible.value = false;
  nextTick(() => textareaEl.value?.focus());
}

// 文件树右键「添加到对话」：所有分屏组的 ChatPanel 都会看到同一个 pending，
// 但只有聚焦组激活 tab（= 选中的会话，props.focused）消费——多工作区会话
// 并存时引用芯片只进选中的那个输入框，与其它会话无关。
const mentionInserter = useMentionInserter();
/** 输入框上方的文件引用芯片（同一文件的同一区间只留一份；整文件与区间引用互不覆盖）；
 *  发送时展开成 `@path` / `@path:12-48` 前缀拼进 prompt。 */
const pendingMentions = ref<Array<{ path: string; isDir: boolean; range?: { start: number; end: number } }>>([]);
/** 芯片去重键：路径 + 区间（同一文件可以既整引又引其中一段）。 */
function mentionKey(path: string, range?: { start: number; end: number }): string {
  return formatMentionPath(path, range);
}
watch(
  () => mentionInserter.pending.value?.nonce,
  () => {
    if (!props.focused) return;
    const m = mentionInserter.consumeMention();
    if (!m) return;
    if (!pendingMentions.value.some((x) => mentionKey(x.path, x.range) === mentionKey(m.path, m.range))) {
      pendingMentions.value.push({ path: m.path, isDir: m.isDir, range: m.range });
    }
    nextTick(() => textareaEl.value?.focus());
  },
);

// 输入框 `@path `→mention 芯片转换层（与来源无关：手打/粘贴/拖入都走这）。
// paste/drop 管道把文件引用以 `@path ` 文本插进 textarea，这里统一扫描转换。
const { onInput: handleMentionInput, scan: scanMentions } = useInlineMention({
  inputText,
  textareaEl,
  workspacePath: () => props.workspacePath ?? "",
  addMention: (path, isDir, range) => {
    if (!pendingMentions.value.some((m) => mentionKey(m.path, m.range) === mentionKey(path, range))) {
      pendingMentions.value.push({ path, isDir, range });
    }
  },
});

const mentionName = pathBasename;
const mentionIcon = getFileIcon;
const folderIconPath = FOLDER_ICON_PATH;

// ── `@` 补全下拉（与 `/` 菜单并列的第二套补全）──────────────────────────────
// 取数/排序/缓存/竞态全在 useMentionSuggest 里；这里只管两件事：事件 → 刷新、
// 选中 → 改写文本（引用交回 useInlineMention 转芯片，不新开第二条转芯片路径）。
// 两套补全互斥：`/` 看整串文本（须以 / 开头且无空格），`@` 看光标锚定的 token。
const {
  token: suggestToken,
  items: suggestItems,
  active: suggestActive,
  visible: suggestOpen,
  refresh: refreshMentions,
  hide: hideSuggest,
  move: moveSuggest,
  current: currentSuggest,
} = useMentionSuggest({
  workspacePath: () => props.workspacePath ?? "",
  // 其它已注册工作区（跨项目开发的主力用法）：候选里排在前面，选中即 @目录 授权
  projects: () => useWorkspaces().workspaces.value,
});
const suggestVisible = computed(() => suggestOpen.value && !slashDropdownVisible.value);

/** 上一次已算过的「光标 + 文本」指纹：input/keyup/click 会为同一次编辑都到这儿，
 *  去重后既省一次 IPC，也保证方向键选行（keyup 会跟一发）不会把高亮打回首行。 */
let lastSuggestSig = "";

/** 按当前文本 + 光标重算候选（@ 比 / 多一维：selectionStart）。 */
function refreshSuggest() {
  const ta = textareaEl.value;
  if (!ta) return;
  const caret = ta.selectionStart ?? ta.value.length;
  const sig = `${caret}|${ta.value}`;
  if (sig === lastSuggestSig) return;
  lastSuggestSig = sig;
  void refreshMentions(ta.value, caret);
}

/** textarea 的 input：先走既有的 `@path `→芯片转换层，再刷新补全菜单。
 *  IME 组合期不弹菜单（与转换层同一判据，避免打断中文输入）。 */
function handleInput(e: InputEvent) {
  handleMentionInput(e);
  if (e.isComposing) return;
  refreshSuggest();
}

/** 光标动了就重算：@ 是光标锚定的，←/→/Home/End 都可能让菜单该关或该换层。 */
function onSuggestCaretKey(e: KeyboardEvent) {
  if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") refreshSuggest();
}

/** 选中一项：改写文本 → 下钻留在菜单里换层；引用则交回转换层转芯片。 */
function pickSuggest(action: "commit" | "drill") {
  const ta = textareaEl.value;
  const item = currentSuggest();
  const tok = suggestToken.value;
  if (!ta || !item || !tok) return;
  // 防御：token 必须还在原处（菜单开着时文本若已变，先重新同步再让用户选）
  if (ta.value.slice(tok.at, tok.at + 1 + tok.query.length) !== `@${tok.query}`) return refreshSuggest();

  const { text, caret } = applyPick(ta.value, tok, item, action);
  inputText.value = text;
  nextTick(() => {
    ta.setSelectionRange(caret, caret);
    if (action === "drill") return refreshSuggest();
    hideSuggest();
    void scanMentions(); // 唯一转芯片路径：写回 `@rel ` 后由它认领
  });
}

/** 点某一行：先把它设为高亮，再按同一套动作走（点「进入」用 drill）。 */
function pickSuggestAt(index: number, action: "commit" | "drill") {
  suggestActive.value = index;
  pickSuggest(action);
}

/** 行尾目录提示：项目行给**父目录**（同名项目靠它区分）、文件行给所在目录；
 *  本层目录行不给——你在哪一层是输入框里明摆着的，重复显示只是噪音。 */
function suggestDirHint(item: MentionSuggestion): string {
  return item.origin === "project" || !item.isDir ? item.dir : "";
}

/** Enter：@ 菜单开着时选中、不发消息（与 / 菜单同款「先吃掉按键」语义）。 */
function onEnterKey() {
  if (suggestVisible.value) return pickSuggest("commit");
  if (slashDropdownVisible.value && filteredSkills.value.length) {
    return selectSkill(filteredSkills.value[slashSelectedIndex.value]);
  }
  return handleSend();
}

/** Esc：两套补全一起关（文本保留）。 */
function onEscapeKey() {
  hideSuggest();
  slashDropdownVisible.value = false;
}

/** → 只在「@ 菜单开着且高亮的是目录」时接管：进该目录继续列子项。 */
function onArrowRight(e: KeyboardEvent) {
  if (!suggestVisible.value || !currentSuggest()?.isDir) return;
  e.preventDefault();
  pickSuggest("drill");
}

// ── 附加目录（@目录 授权）的粘性状态 ────────────────────────────────────────
// 只读镜像：真相在 sidecar worker 的账本里，这里只认 `workspace_attached` 事件
// （全量、幂等）。发送时把已知全量一起报上去（D9），重连自愈靠它。
const attachStore = useSessionAttachedWorkspaces();
const attachedDirs = computed(() => (props.sessionId ? attachStore.attachedOf(props.sessionId) : []));
/** 被 Rust 判掉（未注册/非法）的目录——回声，不参与授权。 */
const rejectedDirs = computed(() => (props.sessionId ? attachStore.rejectedOf(props.sessionId) : []));
/** 活体扩根失败的原文（有值 = 本轮没扩成功，下条消息/新会话会再落）。 */
const attachError = computed(() => (props.sessionId ? attachStore.errorOf(props.sessionId) : undefined));

// ── 键盘 / 粘贴 / 拖放 ──
function handleTabKey(e: KeyboardEvent) {
  // Shift+Tab = 循环权限模式（CLI 同款），与 slash 补全互斥
  if (e.shiftKey) {
    cyclePermissionMode(e);
    return;
  }
  if (suggestVisible.value) {
    e.preventDefault();
    pickSuggest("commit");
    return;
  }
  if (slashDropdownVisible.value && filteredSkills.value.length) {
    e.preventDefault();
    selectSkill(filteredSkills.value[slashSelectedIndex.value]);
  }
}

/** Shift+Tab 循环权限模式：序列剔除 bypassPermissions（见 permissionModeCycle）。
 *  无可切（清单未就位/剔除后不足两项）时不拦截按键，焦点正常移动。 */
function cyclePermissionMode(e: KeyboardEvent) {
  const next = nextPermissionMode(selectedPermissionMode.value, displayPermissionModes.value);
  if (!next) return;
  e.preventDefault();
  handlePermissionModeChange(next);
}

function handleArrowUp(e: KeyboardEvent) {
  if (suggestVisible.value) {
    e.preventDefault();
    moveSuggest(-1);
    return;
  }
  if (slashDropdownVisible.value) {
    e.preventDefault();
    slashSelectedIndex.value = Math.max(0, slashSelectedIndex.value - 1);
  }
}

function handleArrowDown(e: KeyboardEvent) {
  if (suggestVisible.value) {
    e.preventDefault();
    moveSuggest(1);
    return;
  }
  if (slashDropdownVisible.value) {
    e.preventDefault();
    slashSelectedIndex.value = Math.min(filteredSkills.value.length - 1, slashSelectedIndex.value + 1);
  }
}

function insertAtCursor(text: string) {
  const ta = textareaEl.value;
  if (!ta) { inputText.value += text; return; }
  const start = ta.selectionStart ?? inputText.value.length;
  const end = ta.selectionEnd ?? inputText.value.length;
  inputText.value = inputText.value.slice(0, start) + text + inputText.value.slice(end);
  nextTick(() => {
    const pos = start + text.length;
    ta.setSelectionRange(pos, pos);
  });
}

async function handlePaste(e: ClipboardEvent) {
  e.preventDefault();
  const plainText = e.clipboardData?.getData("text/plain") ?? "";
  try {
    // 串行读：clipboardReadFiles 与 clipboardReadImage 各自 OpenClipboard，
    // 同进程并发打开会互斥失败（粘贴偶发为空的真实根因），先 files 后 image。
    const filesRes = await api.clipboardReadFiles();
    const img = await api.clipboardReadImage();
    const res = resolvePastePayload(filesRes.paths, img, peekFileClipboard(), plainText);
    await applyPasteResolution(res);
  } catch {
    if (plainText) insertAtCursor(plainText);
  }
}

/** 把 resolvePastePayload 的结果落进输入框：文本→光标插入；图片路径→base64 附件。
 *  paste 与 drop 共用这条管道，确保两种"把文件弄进输入"的来源行为一致。 */
async function applyPasteResolution(res: PasteResolution) {
  if (res.text) {
    insertAtCursor(res.text);
    // paste/drop 是程序化改 inputText（insertAtCursor 直接赋值），不触发 textarea
    // 的 @input 事件——检测器不会自醒。这里插入 @path 文本后主动扫一次，让芯片
    // 转换立即发生，不必等用户再按键。纯文本扫描无 token 即 no-op。
    void scanMentions();
  }
  let failed = 0;
  for (const imgPath of res.imagePaths) {
    try {
      const data = await api.readFileBase64(imgPath);
      const mediaType = imgPath.toLowerCase().endsWith(".png") ? "image/png"
        : imgPath.toLowerCase().endsWith(".gif") ? "image/gif"
        : imgPath.toLowerCase().endsWith(".webp") ? "image/webp"
        : "image/jpeg";
      pendingImages.value.push({
        data,
        mediaType,
        previewUrl: `data:${mediaType};base64,${data}`,
      });
    } catch (e) {
      // 单张读取失败不阻断其余图片；累计后一次性提示，避免用户以为贴上了
      failed++;
      console.warn("[ChatInputBox] 图片读取失败，已跳过:", e);
    }
  }
  if (failed > 0) showToast(`图片读取失败，已跳过 ${failed} 张`, "danger");
}

/** Uint8Array → base64（分块，避免超大文件一次展开爆栈）。 */
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 允许 OS 文件拖入输入框（OLE 已禁用，WebView2 原生 HTML5 DnD 才会触发）。
 *  preventDefault + dropEffect=copy 消除禁止光标、让 drop 事件落地。 */
function handleDragOver(e: DragEvent) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
}

/** 把拖入的文件接进现有粘贴管道。两路来源：
 *  - 外部 OS 文件：dataTransfer.files。WebView2 不一定暴露 File.path——有则
 *    用真实路径（零额外设施），无则读字节落临时盘兜底拿路径。统一走
 *    resolvePastePayload → @path 引用 / 图片附件。
 *  - 文件树内部拖入：TreeNodeItem.onDragStart 同时 cut(path) 设了 in-app 剪贴板，
 *    以其为准（WebView2 下 dataTransfer.getData 偶发返回空）。拖入输入框是
 *    "引用"不是"移动"，处理后清 cut 态，避免残留半透明与误移。
 *  文件树→文件树的移动走 TreeNodeItem.onDrop，与此处互不干扰（不同落点）。 */
async function handleDrop(e: DragEvent) {
  e.preventDefault();
  e.stopPropagation();
  const dt = e.dataTransfer;
  if (!dt) return;

  const dropped = Array.from(dt.files ?? []);
  let paths: string[] = [];
  let entry: ReturnType<typeof peekFileClipboard> = null;

  let stagedFailed = 0;
  if (dropped.length > 0) {
    for (const file of dropped) {
      const fp = (file as File & { path?: string }).path;
      if (typeof fp === "string" && fp) {
        paths.push(fp);
      } else {
        try {
          const buf = new Uint8Array(await file.arrayBuffer());
          const staged = await api.stageDroppedFile(file.name, encodeBase64(buf));
          paths.push(staged);
        } catch (e) {
          // 单个文件失败不阻断其余；循环结束后一次性提示失败数
          stagedFailed++;
          console.warn("[ChatInputBox] 拖入文件暂存失败，已跳过:", e);
        }
      }
    }
    if (stagedFailed > 0) showToast(`${stagedFailed} 个文件读取失败已跳过`, "danger");
  } else {
    // 内部文件树拖入：onDragStart 调的是 cut(path)，而 resolvePastePayload 只认
    // copy 条目，所以不把 entry 喂给它——直接把路径推进 paths 走 files 分支
    // （拖入输入框一律当"引用"，且图片文件能正确转成附件而非 @path）。
    entry = peekFileClipboard();
    if (entry) paths.push(...entry.paths);
  }

  const res = resolvePastePayload(paths, null, null, "");
  await applyPasteResolution(res);
  if (entry) clearFileClipboard();
}

// ── 发送流 ──
/** 忙碌时发送 = 排队：不排队，交给 sidecar 在安全边界（当前工具调用跑完）
 *  打断当前这轮再发出——见 useChatSession.sendMessage 的注释。
 *
 *  重入守卫 sending：发送期间输入框文本/图片尚未清空——若无守卫，连按两次
 *  Enter 会两次都读到尚在的输入并各 emit 一次，发出两条消息。finally 复位
 *  确保所有早退路径（btw 无参 / skill 读取失败）都能正确解锁，下一次发送可
 *  正常进入。图片不再预检（探测已移除）：模型不支持时由 sidecar 回滚并提示。 */
const sending = ref(false);
async function handleSend() {
  if (sending.value) return;
  sending.value = true;
  try {
    await performSend();
  } finally {
    sending.value = false;
  }
}

async function performSend() {
  const text = inputText.value.trim();
  const hasImages = pendingImages.value.length > 0;
  // 引用芯片 → @path 前缀：发送时才展开成文本，走与手打/粘贴 @path 完全相同的
  // resolveFileMentions 管道（历史 transcript 也因此天然兼容，无需迁移）。
  const mentionPrefix = pendingMentions.value.length
    ? pendingMentions.value.map((m) => "@" + formatMentionPath(m.path, m.range)).join(" ") + " "
    : "";
  // 忙碌时不再拦截：useChatSession 会带排队标记透传，sidecar 在安全边界续发
  if (!text && !hasImages && !mentionPrefix) return;

  // 斜杠命令统一分发：/name 命中命令注册表（useQuickActions，/... 的唯一事实源）
  // 就按 kind 执行——prompt 类与点分裂按钮菜单完全同路径（原文发引擎 + 动作胶囊
  // + 二次确认）；btw 无参数进输入模式、有参数直接发支线。查不到才走 skill /
  // 普通文本。已在 btw 模式里时不拦（输入本来就是支线内容，/btw 字面量无意义）。
  if (!btwMode.value) {
    const cmdMatch = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
    const action = cmdMatch ? quickActions.find((a) => a.command === cmdMatch[1]) : undefined;
    if (action) {
      const args = (cmdMatch?.[2] ?? "").trim();
      if (action.kind === "btw") {
        inputText.value = "";
        pendingImages.value = [];
        pendingMentions.value = [];
        if (!args) {
          toggleBtw(); // 只切输入模式，等问题
          return;
        }
        emit("send-btw", mentionPrefix + args, {
          model: btwModel.value || btwDefaultModel.value,
          effort: btwEffort.value,
        });
        awaitingBtwLaunch.value = true;
        return;
      }
      // prompt 类：菜单点击与手打同出口；取消确认则保留输入、什么都不发。
      // 发送坐实后的输入清空由 sendConfirmedNonce watcher 统一负责。
      await runPromptAction(action, mentionPrefix + text);
      return;
    }
  }

  if (btwMode.value) {
    // btw 一次性:发完自动切回主对话输入。回弹确认(回弹动画 + "已切回"toast)
    // 不在这里乐观触发——等支线真正进入 running 才确认(见上面 status 的 watch),
    // 否则 fork 失败时也会弹"已切回主对话输入"造成误导。
    // 引用芯片在 btw 里只带 @path 字面量（支线没有 mention 展开通道），模型可自行 Read。
    emit("send-btw", mentionPrefix + text, { model: btwModel.value, effort: btwEffort.value });
    inputText.value = "";
    pendingImages.value = [];
    pendingMentions.value = [];
    btwMode.value = false; // 横幅收起、按钮复原
    awaitingBtwLaunch.value = true;
    return;
  }

  let finalPrompt = text;
  const slashMatch = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (slashMatch) {
    const skillName = slashMatch[1];
    const userText = (slashMatch[2] ?? "").trim();
    const skill = skillList.value.find((s) => s.name === skillName);
    if (skill) {
      try {
        const content = await api.readFileContent(skill.filePath);
        finalPrompt = userText ? `${content}\n\n---\n\n${userText}` : content;
      } catch { /* 读取失败则原样发送 */ }
    }
  }

  // headless 的 query() 不会像交互式终端那样把 @path 自动展开成文件内容——
  // 那是 TUI 按键输入层的行为，这里必须自己在发送前把引用的文件读出来拼进
  // 发给模型的文本里，否则模型收到的只是字面量文本，读不读全凭它自己判断
  // （见踩坑记录）。展开后的内容不进 finalPrompt（用户气泡显示用的原文），
  // 只进 mentionResolution.sendText（发给模型用）——避免文件内容和用户
  // 自己打的字混在一个气泡里，读起来很差。
  const mentionResolution = await resolveFileMentions(mentionPrefix + finalPrompt, {
    readFile: api.readFileContent,
    // 有 listDir 才认得目录（@目录 = 授权 + 一级清单）；attachedDirs 命中则只发一行
    // 宣告，不把清单和指令每轮重注一遍。
    listDir: api.listDirectory,
    attachedDirs: attachedDirs.value,
    // 对方仓的 auto memory 索引（F6：query 只 spawn 一次，中途 @ 的记忆只有这条路
    // 当轮可达）。memory 目录的 key 规则在 Rust，前端不抄——由命令按目录解析。
    memoryIndex: (dir) => memoryObservatoryApi.indexForDir(dir),
  });

  // @目录 授权：本条 @ 的目录（剔主根、去重后）并上本端已知账本 —— **已知全量**语义
  // （D9）：sidecar 侧并集合并幂等，杀 sidecar / 重连后重报一遍就自愈。
  const newlyAttached = attachedDirsFrom(mentionResolution, props.workspacePath ?? null);
  const allAttached = [...new Set([...attachedDirs.value, ...newlyAttached])];

  const images = pendingImages.value.map(({ data, mediaType }) => ({ data, mediaType }));
  const sendOpts: SendOptions = {
    images: images.length ? images : undefined,
    // Rust 只在 sidecar 进程还没起来时才会用这个值（见 chat.rs），已有会话时
    // 无害地被忽略，不需要在这里判断"是否已有会话"。
    initialModel: selectedModel.value || undefined,
    // effort 选择器当前值：每条消息都带（存活会话同值幂等），新会话 spawn 时
    // 是初始档位——没有选择器默认值以外的"隐式 effort"。
    initialEffort: selectedEffort.value || undefined,
    mentions: mentionResolution,
    permissionMode: selectedPermissionMode.value || undefined,
    additionalDirs: allAttached.length ? allAttached : undefined,
  };

  // 发送前确认门控（变体 C）已上移到 ChatPanel（onSendRequest）：这里把本次发送
  // 的 provider/模型并进 opts 上报，由 ChatPanel 判定是否弹确认形态。确认后/直接
  // 发送后经 sendConfirmedNonce 坐实清空输入；取消确认不递增，输入保留。
  emit("send-request", mentionPrefix + finalPrompt, {
    ...sendOpts,
    effectiveProvider: identity.effectiveProvider.value,
    effectiveModel: selectedModel.value,
  });
}

// 快捷操作（压缩/清空上下文）：跟手打消息走同一条路径（忙碌排队/权限模式透传都
// 免费拿到），但用户气泡渲染成动作胶囊（emit 时带 action 描述符，见
// useChatSession.dispatchSend）。/clear 不可逆，执行前弹 useModal.confirm 二次确认。
// 菜单点击与手打 /name 统一走 runPromptAction——取消确认则什么都不发、不入队、不推气泡。
async function runPromptAction(action: QuickAction, prompt: string): Promise<boolean> {
  if (action.confirm) {
    const ok = await useModal().confirm(
      action.label,
      "将清空当前会话上下文，不可撤销。是否继续？",
      "清空",
      true,
    );
    if (!ok) return false;
  }
  const sendOpts: SendOptions = {
    initialModel: selectedModel.value || undefined,
    initialEffort: selectedEffort.value || undefined,
    permissionMode: selectedPermissionMode.value || undefined,
    action: { id: action.id, label: action.label, icon: action.icon },
  };
  // 发送前确认门控已上移到 ChatPanel（onSendRequest）：这里把 provider/模型并进 opts。
  emit("send-request", prompt, {
    ...sendOpts,
    effectiveProvider: identity.effectiveProvider.value,
    effectiveModel: selectedModel.value,
  });
  return true;
}

/** 分裂按钮菜单选择：btw 是输入模式切换（不发消息），prompt 类与手打 /name 同路径。 */
async function handleQuickAction(action: QuickAction) {
  if (action.kind === "btw") {
    toggleBtw();
    return;
  }
  await runPromptAction(action, "/" + action.command);
}

// 发送坐实（ChatPanel 门控通过/确认后递增 nonce）：清空输入。取消确认不递增，
// 输入保留——与旧实现「取消时内容回退对话框」语义一致。
watch(() => props.sendConfirmedNonce, () => {
  inputText.value = "";
  pendingImages.value = [];
  pendingMentions.value = [];
});

// hero 头展示的模型名（ChatPanel 的 hero 标题行用）：选中模型变化时上报。
const heroModelName = computed(
  () => displayModels.value.find((m) => m.value === selectedModel.value)?.displayName ?? "",
);
watch(heroModelName, (v) => emit("hero-model-name", v), { immediate: true });

// 工具栏快捷操作（/compact /clear）：composable 早就写好且有单测，但从没接到
// UI 上过——之前工具栏里完全看不到这两个按钮。见 handleQuickAction。
const { actions: quickActions } = useQuickActions();
</script>

<template>
  <div ref="rootEl" class="chat-input-area" :class="{ 'chat-input-area--hero': isHero }">
    <!-- Slash command dropdown -->
    <div v-if="filteredSkills.length" class="skill-dropdown">
      <div
        v-for="(skill, i) in filteredSkills"
        :key="skill.provider + ':' + skill.name"
        :class="['skill-item', i === slashSelectedIndex ? 'skill-item--active' : '']"
        @mousedown.prevent="selectSkill(skill)"
      >
        <span class="skill-item-name">/{{ skill.name }}</span>
        <span class="skill-item-source">{{ skill.source }}</span>
        <span class="skill-item-desc">{{ skill.description }}</span>
      </div>
    </div>
    <!-- @ 提及补全下拉：与 / 菜单同位置（输入盒上方、贴左右边距），锚在输入盒而非光标。
         同层命中行尾留空、全仓兜底挂「全仓」弱标签并显示所在目录（两者一眼可分）。 -->
    <div v-if="suggestVisible" class="skill-dropdown mention-dropdown">
      <div
        v-for="(item, i) in suggestItems"
        :key="item.rel"
        :class="['skill-item', 'mention-item', i === suggestActive ? 'skill-item--active' : '']"
        @mousedown.prevent="pickSuggestAt(i, 'commit')"
      >
        <svg
          v-if="item.isDir"
          class="mention-item-icon"
          width="13" height="13" viewBox="0 0 24 24" fill="none"
        >
          <path
            d="M3 6.2a1.6 1.6 0 0 1 1.6-1.6h3.1l1.7 1.9h7.4A1.6 1.6 0 0 1 18.4 8v8.2a1.6 1.6 0 0 1-1.6 1.6H4.6A1.6 1.6 0 0 1 3 16.4z"
            fill="currentColor" opacity="0.85"
          />
        </svg>
        <svg v-else class="mention-item-icon" width="13" height="13" viewBox="0 0 24 24" fill="none">
          <path
            d="M7 2.6h6.2L18 7.4v13a1.6 1.6 0 0 1-1.6 1.6H7a1.6 1.6 0 0 1-1.6-1.6V4.2A1.6 1.6 0 0 1 7 2.6zm6 1.6v3.6h3.6"
            fill="currentColor" opacity="0.85"
          />
        </svg>
        <span class="mention-item-name">{{ item.name }}</span>
        <span
          v-if="item.origin !== 'local'"
          :class="['mention-item-tag', item.origin === 'project' && 'mention-item-tag--project']"
        >{{ item.origin === 'project' ? '项目' : '全仓' }}</span>
        <span class="mention-item-right">
          <!-- 行尾所在目录：不带尾斜杠——RTL 省略会把尾斜杠翻到左边显示成 "/src"，反而像绝对路径 -->
          <span v-if="suggestDirHint(item)" class="mention-item-rel">{{ suggestDirHint(item) }}</span>
          <button
            v-if="item.isDir"
            type="button"
            class="mention-item-enter"
            @mousedown.prevent.stop="pickSuggestAt(i, 'drill')"
          >→ 进入</button>
        </span>
      </div>
      <div class="mention-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
        <span><kbd>→</kbd> 进入目录</span>
        <span><kbd>回车</kbd> 引用</span>
        <span><kbd>Esc</kbd> 关闭</span>
      </div>
    </div>
    <!-- 输入框、图片缩略图、模型工具栏放进同一个带边框的盒子里，工具栏焊在底部——
         不再是"模型栏单独一行浮在输入框上方"，避免贴图片时模型栏被顶得到处跑。 -->
    <!-- 忙碌时排队、正在等安全边界（当前回合结束）的消息：sidecar 已登记，不可撤回 -->
    <div v-if="pendingJumps?.length" class="jump-strip">
      <div v-for="(p, i) in pendingJumps" :key="i" class="jump-item">
        <span class="jump-item-tag">排队</span>
        <span class="jump-item-text">{{ p.text }}</span>
        <span class="jump-item-hint">等当前回合结束发出</span>
      </div>
    </div>
    <!-- 最小化后支线仍在后台跑:浮一个可点开重展抽屉的小标(done 后结论已进批注,不再浮) -->
    <Transition name="btw-chip">
      <button
        v-if="btwBgChipVisible"
        class="btw-bg-chip"
        v-tooltip="'支线还在后台跑,点开重展抽屉'"
        @click="reopenBtw"
      >
        <span class="btw-bg-chip-glyph">↳</span> btw 后台运行中
        <span class="btw-bg-chip-pulse"></span>
      </button>
    </Transition>
    <div
      class="chat-input-box"
      :class="{ 'btw-mode': btwMode, 'session-running': isBusy }"
      @dragover.prevent="handleDragOver"
      @drop.prevent="handleDrop"
    >
      <Transition name="btw-banner">
        <div v-if="btwMode" class="btw-mode-banner">
          <span class="btw-banner-glyph">↳</span>
          <span class="btw-banner-text"><b>顺便问一下</b> · 不进入主对话 · 阅后即弃</span>
          <button type="button" class="btw-banner-x" @click="btwMode = false" v-tooltip="'退出 btw 模式'">×</button>
        </div>
      </Transition>
      <!-- 文件引用芯片（文件树右键「添加到对话」）：发送时展开成 @path 前缀 -->
      <div v-if="pendingMentions.length" class="mention-strip">
        <div
          v-for="(m, i) in pendingMentions"
          :key="mentionKey(m.path, m.range)"
          class="mention-chip"
          v-tooltip="formatMentionPath(m.path, m.range)"
        >
          <svg
            v-if="m.isDir"
            class="mention-chip-icon mention-chip-icon--folder"
            width="13" height="13" viewBox="0 0 24 24" fill="none"
          >
            <path :d="folderIconPath" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <svg
            v-else
            class="mention-chip-icon"
            :style="{ color: mentionIcon(mentionName(m.path)).color }"
            width="13" height="13" viewBox="0 0 24 24" fill="none"
          >
            <path :d="mentionIcon(mentionName(m.path)).path" fill="currentColor" opacity="0.85"/>
          </svg>
          <!-- 区间引用（编辑器选区）在文件名后带 :起-止，一眼区分整文件引用 -->
          <span class="mention-chip-name">
            {{ mentionName(m.path) }}<span v-if="m.range" class="mention-chip-range">:{{ m.range.start }}-{{ m.range.end }}</span>
          </span>
          <button class="mention-chip-remove" @click="pendingMentions.splice(i, 1)">×</button>
        </div>
      </div>
      <!-- 已授权的附加目录（@目录，本会话内粘性）：只读——来源是 sidecar 的全量账本事件，
           不做移除按钮（要解除就开新会话）。拒绝/失败同样在这里回声，不许静默。 -->
      <div v-if="attachedDirs.length || rejectedDirs.length || attachError" class="attach-strip">
        <div v-for="d in attachedDirs" :key="d" class="attach-chip" v-tooltip="d">
          <svg class="attach-chip-icon" width="13" height="13" viewBox="0 0 24 24" fill="none">
            <path :d="folderIconPath" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span class="attach-chip-name">{{ mentionName(d) }}</span>
          <span class="attach-chip-tag">已授权</span>
        </div>
        <div v-if="rejectedDirs.length" class="attach-warn" v-tooltip="rejectedDirs.join('\n')">
          未注册，已忽略：{{ mentionName(rejectedDirs[0])
          }}<span v-if="rejectedDirs.length > 1"> 等 {{ rejectedDirs.length }} 个</span>
        </div>
        <div v-else-if="attachError" class="attach-warn" v-tooltip="attachError">
          附加目录本轮未生效，下条消息会重试
        </div>
      </div>
      <div v-if="pendingImages.length" class="image-attachment-strip">
        <div
          v-for="(img, i) in pendingImages"
          :key="i"
          class="image-thumb"
        >
          <img :src="img.previewUrl" class="image-thumb-img" alt="附图" />
          <button class="image-thumb-remove" @click="pendingImages.splice(i, 1)">×</button>
        </div>
      </div>
      <textarea
        ref="textareaEl"
        v-model="inputText"
        class="chat-input"
        :placeholder="btwMode ? '顺便问一下,不进入主对话…' : (isBusy ? '生成中，发送的消息将排队…' : (isHero ? '你正在解决什么问题？' : '输入消息…'))"
        rows="3"
        @keydown.enter.exact.prevent="onEnterKey"
        @keydown.enter.shift.exact.prevent="insertAtCursor('\n')"
        @keydown.tab="handleTabKey"
        @keydown.escape="onEscapeKey"
        @keydown.right="onArrowRight"
        @keydown.up="handleArrowUp"
        @keydown.down="handleArrowDown"
        @keyup="onSuggestCaretKey"
        @click="refreshSuggest"
        @focus="refreshSuggest"
        @paste="handlePaste"
        @input="handleInput"
      />
      <div class="chat-toolbar">
        <ThemedSelect
          v-if="displayModels.length"
          :model-value="displayedModel"
          :options="modelSelectOptions"
          title="模型"
          @update:model-value="handleModelChange"
        />
        <!-- effort 选择器：会话级思考深度，切换即时生效（sidecar applyFlagSettings，
             不重启进程、不碰 prompt 缓存）；三档制：快速=关闭思考模式、进阶/极致=
             开启思考（worker 侧 thinkingForEffort 联动）；默认 思考(high) -->
        <ThemedSelect
          :model-value="displayedEffort"
          :options="effortSelectOptions"
          title="effort（思考深度）：快速=关闭思考模式、进阶/极致=开启思考；切换从下一轮起生效，不影响缓存"
          @update:model-value="handleEffortChange"
        />
        <div
          v-if="displayPermissionModes.length"
          class="perm-mode-wrap"
          :class="{ 'perm-mode-wrap--bypass': selectedPermissionMode === 'bypassPermissions' }"
        >
          <ThemedSelect
            :model-value="selectedPermissionMode"
            :options="permissionModeSelectOptions"
            title="权限模式"
            @update:model-value="handlePermissionModeChange"
          />
          <span
            v-if="selectedPermissionMode === 'bypassPermissions'"
            class="perm-bypass-badge"
            v-tooltip="'已跳过所有工具权限确认（含本会话派生的所有子代理，子代理会继承此模式且不能单独覆盖），仅本会话生效；切换/新建会话会恢复默认权限模式'"
          >⚠️ 跳过确认</span>
        </div>
        <div
          v-for="w in rateLimitWindows"
          :key="w.key"
          class="chat-quota"
          :class="`chat-quota--${w.status}`"
          v-tooltip="w.title"
        >
          <span class="chat-quota-dot" />
          <span class="chat-quota-label">{{ w.label }}</span>
          <div class="chat-ctx-bar">
            <div class="chat-ctx-bar-fill" :style="{ width: w.pct + '%' }" />
          </div>
          <span class="chat-ctx-percent">{{ w.pct }}%</span>
        </div>
        <!-- 右侧组整体吸边：auto margin 挂在组容器上而不是发送按钮——否则
             弹性空隙会插在环形与发送之间，环形被留在左侧队列（真踩过） -->
        <div class="chat-toolbar-right">
          <ContextUsageRing
            v-if="contextUsage"
            ref="usageRingRef"
            :usage="contextUsage"
            @open="usagePanelOpen = true"
          />
          <ChatSendButton
            :disabled="(!inputText.trim() && !pendingImages.length && !pendingMentions.length) || sending"
            :busy="isBusy && !btwMode"
            :actions="quickActions"
            :btw-active="btwMode"
            :btw-disabled="!sessionId"
            :btw-disabled-reason="'先发送一条消息开始主对话，才能顺便问一下'"
            @send="handleSend()"
            @select="handleQuickAction"
          />
        </div>
      </div>
    </div>
    <Transition name="btw-toast">
      <div v-if="btwRevertToast" class="btw-revert-toast">已切回主对话输入</div>
    </Transition>
    <AToast :state="toastState" />
    <ContextUsagePanel
      v-if="usagePanelOpen"
      :usage="contextUsage ?? null"
      :anchor="usageRingEl"
      :rate-limit="rateLimit ?? null"
      @close="usagePanelOpen = false"
    />
  </div>
</template>

<style scoped>
.chat-input-area {
  border-top: 1px solid var(--aide-border);
  padding: 8px 12px;
  flex-shrink: 0;
  position: relative;
}

/* ── hero（零会话欢迎态）────────────────────────────────────────────
   同一棵 DOM 换布局：输入盒居中放大（hero 的标题行/消息区布局在 ChatPanel，
   这里只管输入盒自身的 hero 形态）。进出 hero 的动画只动 transform/opacity
   （FLIP 的 JS 部分在 ChatPanel 的 isHero watch，量的是本组件根元素）。 */
.chat-input-area--hero {
  flex: none;
  width: min(680px, 92%);
  margin: 0 auto;
  padding: 0;
  border-top: none;
  animation: hero-rise .22s var(--aide-ease);
}

.chat-input-area--hero .chat-input-box {
  box-shadow: var(--aide-shadow-lg);
}

@keyframes hero-rise {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  .chat-input-area--hero {
    animation: none;
  }
}

/* 统一的带边框输入盒子——图片缩略图、文本框、模型工具栏都在里面，
   焦点样式挂在盒子本身（:focus-within），不是内层 textarea 单独一圈边框。 */
.chat-input-box {
  display: flex;
  flex-direction: column;
  border-radius: var(--aide-radius-sm);
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border);
  transition: all var(--aide-ease-t);
}

.chat-input-box:focus-within {
  border-color: var(--aide-accent);
}

/* 运行中聚焦不再整圈 accent 描边——边框保持素色，让彗星环成为唯一的彩色信号 */
.chat-input-box.session-running:focus-within {
  border-color: var(--aide-border);
}

/* 会话运行时输入盒流光（双向对追双彗星 + 柔光晕）：纯 CSS 单伪元素，零 JS。
   ::before 的 conic 渐变随 @property 角度旋转（两颗彗星相隔 180° 对跑），
   2 层 mask + exclude 只露出 1px 锐环、精确压盖住边框；光晕用 drop-shadow
   实现——关键教训：filter 作用于 mask 之后的结果，所以 drop-shadow 严格
   跟随环形（盒内一笔不画，glass 半透明背景主题也安全）；而 blur 在 mask 前
   生效、会被 mask 裁出硬边平顶光带（"粗边框"观感的来源），不能用。
   另注意此 WebView2 只支持单值 mask-composite，3 层以上多值组合整条失效
   （退化成全叠加、光楔糊满输入框），mask 层数必须 ≤2。
   渐变淡出端用 color-mix 0% 同色透明，不用 transparent 关键字（透明黑插值
   会经过发暗中间色、光带显脏）。颜色全走主题 token，空闲时无伪元素零开销。 */
@property --aide-input-comet {
  syntax: "<angle>";
  initial-value: 0deg;
  inherits: false;
}

.chat-input-box.session-running {
  position: relative;
  isolation: isolate;
}

.chat-input-box.session-running::before {
  content: "";
  position: absolute;
  inset: 0;
  padding: 1px;
  border-radius: var(--aide-radius-sm);
  pointer-events: none;
  background: conic-gradient(
    from var(--aide-input-comet),
    color-mix(in srgb, var(--aide-accent) 0%, transparent) 0deg,
    var(--aide-accent) 30deg,
    var(--aide-accent-hover) 42deg,
    color-mix(in srgb, var(--aide-accent-hover) 0%, transparent) 55deg,
    color-mix(in srgb, var(--aide-accent) 0%, transparent) 180deg,
    var(--aide-accent) 210deg,
    var(--aide-accent-hover) 222deg,
    color-mix(in srgb, var(--aide-accent-hover) 0%, transparent) 235deg,
    color-mix(in srgb, var(--aide-accent) 0%, transparent) 360deg
  );
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  filter: drop-shadow(0 0 10px color-mix(in srgb, var(--aide-accent) 85%, transparent));
  animation: chat-input-comet 3.2s linear infinite;
}

@keyframes chat-input-comet {
  to { --aide-input-comet: 360deg; }
}

.chat-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-top: 1px solid var(--aide-border);
  font-size: 12px;
  color: var(--aide-text-secondary);
}

/* bypassPermissions（跳过所有确认）常驻警示：不用一次性确认框，而是选中期间持续
 * 可见的红色信号，提醒当前会话正在跳过所有工具权限确认。注意类名用 --bypass 而非
 * --auto：auto 是另一个独立的权限模式（模型分类器判断），不要和这里的危险模式混淆。 */
.perm-mode-wrap {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.perm-mode-wrap--bypass :deep(.themed-select) {
  border-color: var(--aide-danger);
  color: var(--aide-danger);
}

.perm-bypass-badge {
  font-size: 11px;
  color: var(--aide-danger);
  white-space: nowrap;
}

/* chat-ctx-bar / chat-ctx-bar-fill / chat-ctx-percent 仍被 5h 额度胶囊使用 */
.chat-ctx-bar {
  width: 48px;
  height: 5px;
  border-radius: 3px;
  background: var(--aide-surface-hover);
  overflow: hidden;
}

.chat-ctx-bar-fill {
  height: 100%;
  background: var(--aide-accent);
  transition: width var(--aide-ease-t);
}

.chat-ctx-percent {
  white-space: nowrap;
  min-width: 28px;
}

.chat-quota {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--aide-text-muted);
  cursor: default;
}

.chat-quota-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--aide-accent);
}

.chat-quota-label {
  white-space: nowrap;
}

/* 归一化状态色：ok 走强调色、warning 橙、exceeded 红（点 + 进度条同步变色）。 */
.chat-quota--warning .chat-quota-dot,
.chat-quota--warning .chat-ctx-bar-fill {
  background: var(--aide-warning);
}
.chat-quota--warning .chat-quota-label { color: var(--aide-warning); }

.chat-quota--exceeded .chat-quota-dot,
.chat-quota--exceeded .chat-ctx-bar-fill {
  background: var(--aide-danger);
}
.chat-quota--exceeded .chat-quota-label { color: var(--aide-danger); font-weight: 600; }

.chat-input {
  resize: none;
  border: none;
  background: transparent;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--aide-text-primary);
  outline: none;
  font-family: inherit;
  line-height: 1.5;
}

.chat-input::placeholder {
  color: var(--aide-text-muted);
}

.chat-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 分裂式发送按钮（ChatSendButton 根元素）：始终靠右。按钮自身的外观在
 * ChatSendButton.vue 内。 */
/* 工具条右侧组（环形 + 发送分裂按钮）整体吸边；auto 在组容器上，
   环形才真正贴着发送按钮，且环形缺省（无用量数据）时发送仍吸右 */
.chat-toolbar-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

.skill-dropdown {
  position: absolute;
  bottom: 100%;
  left: 12px;
  right: 12px;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  box-shadow: var(--aide-shadow-lg);
  z-index: 100;
  max-height: 280px;
  overflow-y: auto;
  margin-bottom: 4px;
}

.skill-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 12px;
  overflow: hidden;
}

.skill-item:hover,
.skill-item--active {
  background: var(--aide-surface-hover);
}

.skill-item-name {
  font-weight: 600;
  color: var(--aide-accent);
  flex-shrink: 0;
  font-family: var(--aide-font-mono);
}

.skill-item-source {
  font-size: 10px;
  color: var(--aide-text-muted);
  flex-shrink: 0;
  background: var(--aide-bg-deep);
  padding: 1px 4px;
  border-radius: 3px;
}

.skill-item-desc {
  color: var(--aide-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

/* ── `@` 提及补全行（容器复用 .skill-dropdown，行密度与 .skill-item 对齐） ── */
.mention-item {
  align-items: center;
  gap: 7px;
}

.mention-item-icon {
  flex-shrink: 0;
  color: var(--aide-text-muted);
}

.mention-item-name {
  font-family: var(--aide-font-mono);
  font-size: 12px;
  color: var(--aide-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
}

/* 全仓兜底行的弱标签：同层命中行尾留空，靠它 + 行尾相对路径区分两种来源 */
.mention-item-tag {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--aide-text-muted);
  background: var(--aide-bg-deep);
  padding: 1px 4px;
  border-radius: 3px;
}

/* 项目（其它已注册工作区）用 accent 弱标签：它与「全仓」是两种来源，不能长一样 */
.mention-item-tag--project {
  color: var(--aide-accent);
  background: var(--aide-accent-subtle);
}

/* 行尾区（目录提示 + 「进入」胶囊）：两者可同时出现——项目行就是两个都要 */
.mention-item-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

/* 行尾相对路径：RTL 省略保尾部（长路径下最该看见的是它所在的深层目录） */
.mention-item-rel {
  min-width: 0;
  font-family: var(--aide-font-mono);
  font-size: 10.5px;
  color: var(--aide-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}

/* 目录行的「进入」：目录默认动作是引用，这个非默认动作必须在行内可见 */
.mention-item-enter {
  flex-shrink: 0;
  font-family: inherit;
  font-size: 10px;
  color: var(--aide-text-muted);
  background: transparent;
  border: 1px solid var(--aide-border);
  border-radius: 999px;
  padding: 0 6px;
  cursor: pointer;
  white-space: nowrap;
}

.mention-item:hover .mention-item-enter,
.skill-item--active .mention-item-enter {
  color: var(--aide-accent);
  border-color: var(--aide-accent);
}

/* 操作提示钉在底部：滚动列表时也在（「→ 能进入」不是默认行为，得让人知道） */
.mention-foot {
  position: sticky;
  bottom: 0;
  display: flex;
  gap: 12px;
  padding: 4px 10px 5px;
  background: var(--aide-bg-raised);
  border-top: 1px solid var(--aide-border-subtle);
  font-size: 10px;
  color: var(--aide-text-muted);
}

.mention-foot span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.mention-foot kbd {
  font-family: var(--aide-font-mono);
  font-size: 10px;
  color: var(--aide-text-secondary);
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  border-radius: 3px;
  padding: 0 4px;
}

.jump-strip {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 6px;
}

.jump-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--aide-text-secondary);
  background: var(--aide-surface-default);
  border: 1px dashed var(--aide-border);
  border-radius: var(--aide-radius-sm);
}

.jump-item-tag {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--aide-accent);
  background: var(--aide-accent-subtle);
  padding: 1px 4px;
  border-radius: 3px;
}

.jump-item-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.jump-item-hint {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--aide-text-muted);
}

/* ── 文件引用芯片 ── */
.mention-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 12px 0;
}

.mention-chip {
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 220px;
  padding: 3px 5px 3px 7px;
  border-radius: var(--aide-radius-sm);
  border: 1px solid var(--aide-border);
  background: var(--aide-surface-default);
  font-size: 11px;
  color: var(--aide-text-secondary);
  user-select: none;
}

.mention-chip-icon {
  flex-shrink: 0;
}

.mention-chip-icon--folder {
  color: var(--aide-text-muted);
}

/* ── 已授权附加目录（只读 · 粘性） ── */
.attach-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 8px 12px 0;
}

.attach-chip {
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 260px;
  padding: 3px 7px;
  border-radius: var(--aide-radius-sm);
  border: 1px solid var(--aide-border);
  background: var(--aide-surface-default);
  font-size: 11px;
  color: var(--aide-text-secondary);
  user-select: none;
}

.attach-chip-icon {
  flex-shrink: 0;
  color: var(--aide-text-muted);
}

.attach-chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attach-chip-tag {
  flex-shrink: 0;
  padding: 0 4px;
  border-radius: var(--aide-radius-sm);
  background: var(--aide-accent-subtle);
  color: var(--aide-accent);
  font-size: 10px;
}

.attach-warn {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--aide-text-muted);
}

.mention-chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 选区引用的行号后缀：弱化成次要色，不与文件名抢视线 */
.mention-chip-range {
  color: var(--aide-text-muted);
}

.mention-chip-remove {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--aide-text-muted);
  cursor: pointer;
  font-size: 11px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.mention-chip-remove:hover {
  background: var(--aide-danger);
  color: var(--aide-text-primary);
}

.image-attachment-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 12px 0;
}

.image-thumb {
  position: relative;
  width: 56px;
  height: 56px;
  border-radius: var(--aide-radius-sm);
  overflow: hidden;
  border: 1px solid var(--aide-border);
  flex-shrink: 0;
}

.image-thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.image-thumb-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--aide-bg-overlay);
  color: var(--aide-text-primary);
  border: none;
  cursor: pointer;
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  line-height: 1;
}

.image-thumb-remove:hover {
  background: var(--aide-danger);
}

/* ── btw 模式 ── */
.btw-mode-banner {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 11px;
  font-size: 11px;
  color: var(--aide-accent);
  background: color-mix(in srgb, var(--aide-accent) 8%, transparent);
  border-bottom: 1px solid var(--aide-border-subtle);
}
.btw-banner-glyph { font-size: 14px; line-height: 1; }
.btw-banner-text { flex: 1; }
.btw-banner-text b { color: var(--aide-accent); }
.btw-banner-x {
  background: none; border: none; color: var(--aide-accent);
  font-size: 14px; cursor: pointer; opacity: 0.8; line-height: 1;
}
.btw-banner-x:hover { opacity: 1; }
.chat-input-box.btw-mode {
  border-color: var(--aide-accent);
  box-shadow: 0 0 0 2px var(--aide-accent-subtle);
}
.chat-input-box.btw-revert-flash { animation: btw-revert-flash 0.8s ease-out; }
@keyframes btw-revert-flash {
  0% { border-color: var(--aide-accent); box-shadow: 0 0 0 3px var(--aide-accent-subtle); }
  40% { border-color: var(--aide-accent); box-shadow: 0 0 0 3px var(--aide-accent-subtle); }
  100% { border-color: var(--aide-border); box-shadow: none; }
}
.btw-revert-toast {
  position: absolute; left: 50%; transform: translateX(-50%);
  bottom: 100%; margin-bottom: 6px;
  background: var(--aide-bg-raised); border: 1px solid var(--aide-accent);
  color: var(--aide-accent); font-size: 11px; padding: 4px 12px;
  border-radius: 999px; box-shadow: var(--aide-shadow-md);
  z-index: 40; pointer-events: none; white-space: nowrap;
}
.btw-banner-enter-active, .btw-banner-leave-active { transition: opacity 0.2s, max-height 0.25s; overflow: hidden; }
.btw-banner-enter-from, .btw-banner-leave-to { opacity: 0; max-height: 0; }
.btw-toast-enter-active, .btw-toast-leave-active { transition: opacity 0.2s, transform 0.2s; }
.btw-toast-enter-from, .btw-toast-leave-to { opacity: 0; transform: translate(-50%, 4px); }

/* 最小化后重展抽屉的入口浮标:支线仍在后台跑时显示,点开重展。 */
.btw-bg-chip {
  display: inline-flex; align-items: center; gap: 6px;
  margin: 0 0 8px auto; padding: 4px 11px;
  background: color-mix(in srgb, var(--aide-accent) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--aide-accent) 40%, transparent);
  color: var(--aide-accent); font-size: 11.5px;
  border-radius: 999px; cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease;
}
.btw-bg-chip:hover { background: color-mix(in srgb, var(--aide-accent) 20%, transparent); border-color: var(--aide-accent); }
.btw-bg-chip-glyph { font-size: 13px; line-height: 1; }
.btw-bg-chip-pulse {
  width: 6px; height: 6px; border-radius: 50%; background: var(--aide-accent);
  animation: btw-chip-pulse 1.4s ease-in-out infinite;
}
@keyframes btw-chip-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
.btw-chip-enter-active, .btw-chip-leave-active { transition: opacity 0.18s, transform 0.18s; }
.btw-chip-enter-from, .btw-chip-leave-to { opacity: 0; transform: translateY(4px); }
</style>
