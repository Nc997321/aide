<script setup lang="ts">
/**
 * ProviderSettings —— 供应商设置面板（kind-aware 重构，Task 9）。
 *
 * 设计要点：
 * - 单一 `form` state（深拷贝 selectedProvider），去掉旧 systemDefaultMappings / custom 双套。
 * - SystemDefault 现在是 kind=system_default 的正常 preset 条目，不再走特殊分支。
 * - isPreset = kind !== "custom" → name/icon/baseUrl 只读；Custom 全可编辑。
 * - authMode = presetForKind(kind)?.auth_mode → 预置只显示对应凭证框；Custom 两个都显示。
 * - handleSave 统一走 updateProvider（含 SystemDefault），落盘出口从旧 saveSystemDefaultMappings
 *   改为 updateProvider(__system_default__, …)；组装字段与改前逐字段一致（见 task-9-report）。
 * - 底部挂 ProviderActions 按 kind dispatch（Custom 自动不渲染）。
 * - "+ 添加" 打开 ProviderCatalogPicker，preset 卡片 + Custom 入口。
 */
import { ref, computed, watch, onMounted } from "vue";
import { useProviders } from "../composables/useProviders";
import { useProviderCatalog } from "../composables/useProviderCatalog";
import { useToast } from "../composables/useToast";
import { useModal } from "../composables/useModal";
import ProviderActions from "./provider/ProviderActions.vue";
import ProviderCatalogPicker from "./provider/ProviderCatalogPicker.vue";
import ProviderLogo from "./ProviderLogo.vue";
import Icon from "./Icon.vue";
import AToast from "../ui/AToast.vue";
import ThemedSelect from "./ThemedSelect.vue";
import { PROVIDER_GLYPHS } from "@/utils/icons";
import type { ProviderConfig, ProviderKind, ProviderModelMappings, SecretMutation } from "../types";

// 三档制：快速(low)=关闭思考模式、思考(high)/深度思考(max)=开启思考。
// 历史档位 MEDIUM/XHIGH 由 normalizeEffortOption 迁移到相邻档位，不再出现在选择器。
const effortOptions = [
  { value: "", label: "默认" },
  { value: "LOW", label: "快速" },
  { value: "HIGH", label: "思考" },
  { value: "MAX", label: "深度思考" },
];

const {
  displayList,
  activeProviderId,
  load,
  updateProvider,
  deleteProvider,
  setActiveProvider,
  addPresetProvider,
  addCustomProvider,
  SYSTEM_DEFAULT_ID,
} = useProviders();
const { presetForKind, loadCatalog } = useProviderCatalog();
const { toastState, showToast } = useToast();
const modal = useModal();

const selectedId = ref<string>(SYSTEM_DEFAULT_ID);
const showPicker = ref(false);

const selectedProvider = computed<ProviderConfig | undefined>(() =>
  displayList.value.find((p) => p.id === selectedId.value),
);

const isPreset = computed(() => selectedProvider.value?.kind !== "custom");
const isSystemDefault = computed(() => selectedProvider.value?.kind === "system_default");
const preset = computed(() =>
  selectedProvider.value ? presetForKind(selectedProvider.value.kind) : undefined,
);
// undefined for Custom → 模板里两个凭证框都显示；预置按 auth_mode 只显示一个
const authMode = computed(() => preset.value?.auth_mode);

// 编辑态：深拷贝 selectedProvider，避免直接改 store。
// modelMappings / knownModels 单独浅拷贝，防止编辑时 mutate store 引用。
const form = ref<ProviderConfig | null>(null);
// 凭据框显隐切换——必须在下面的 watch(..., {immediate: true}) 之前声明：
// immediate 回调在 setup 同步阶段就跑，会重置这俩 ref；若声明在后面会触发 TDZ
// （ReferenceError: Cannot access 'showApiKey' before initialization），导致整个
// ProviderSettings 挂载失败（providers tab 空白 + 父 SettingsPanel 关闭按钮失效）。
const apiKeyInput = ref("");
const authTokenInput = ref("");
const apiKeyMutation = ref<SecretMutation>({ action: "unchanged" });
const authTokenMutation = ref<SecretMutation>({ action: "unchanged" });
watch(
  selectedProvider,
  (p) => {
    form.value = p
      ? {
          ...p,
          modelMappings: { ...p.modelMappings },
          knownModels: [...p.knownModels],
        }
      : null;
    apiKeyInput.value = "";
    authTokenInput.value = "";
    apiKeyMutation.value = { action: "unchanged" };
    authTokenMutation.value = { action: "unchanged" };
  },
  { immediate: true },
);

onMounted(() => {
  void load();
  void loadCatalog();
});

function selectProvider(id: string) {
  selectedId.value = id;
}

async function handleActivate(id: string) {
  await setActiveProvider(id);
  showToast("已切换供应商", "success");
}

async function handleAdd() {
  showPicker.value = true;
}

async function onPickerSelect(kind: ProviderKind) {
  showPicker.value = false;
  try {
    const p = await addPresetProvider(kind);
    selectedId.value = p.id;
    showToast("已添加：" + p.name, "success");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast("添加失败：" + msg, "danger");
  }
}

async function onPickerCustom() {
  showPicker.value = false;
  try {
    const p = await addCustomProvider();
    selectedId.value = p.id;
    showToast("已添加自定义供应商", "success");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast("添加失败：" + msg, "danger");
  }
}

async function handleSave() {
  if (!form.value) return;
  const f = form.value;
  const mappings: ProviderModelMappings = { ...f.modelMappings };
  // type="number" input 在 Vue 3 v-model 下会被 looseToNumber 成 JS number；
  // Rust 侧字段是 String，传数字会让 setProviders 反序列化失败、保存静默丢失——
  // 这里强制转字符串（保留改前行为）。
  await updateProvider(f.id, {
    name: f.name,
    icon: f.icon,
    baseUrl: f.baseUrl,
    modelMappings: mappings,
    effortLevel: f.effortLevel,
    autoCompactWindow: String(f.autoCompactWindow ?? ""),
    autocompactPctOverride: String(f.autocompactPctOverride ?? ""),
    maxContextTokens: String(f.maxContextTokens ?? ""),
    knownModels: [...f.knownModels],
  }, {
    apiKey: apiKeyInput.value ? { action: "set", value: apiKeyInput.value } : apiKeyMutation.value,
    authToken: authTokenInput.value ? { action: "set", value: authTokenInput.value } : authTokenMutation.value,
  });
  apiKeyInput.value = "";
  authTokenInput.value = "";
  apiKeyMutation.value = { action: "unchanged" };
  authTokenMutation.value = { action: "unchanged" };
  showToast("已保存", "success");
}

async function handleDelete() {
  if (!selectedProvider.value || isSystemDefault.value) return;
  const ok = await modal.confirm(
    "删除供应商",
    `确定删除「${selectedProvider.value.name}」？`,
    "删除",
    true,
  );
  if (!ok) return;
  await deleteProvider(selectedProvider.value.id);
  selectedId.value = SYSTEM_DEFAULT_ID;
  showToast("已删除", "info");
}

// ── known_models 标签管理（保留现有逻辑，改成不可变更新以配合 watch 深拷贝）──
const newModelTag = ref("");
function addModelTag() {
  if (!form.value) return;
  const tag = newModelTag.value.trim();
  if (tag && !form.value.knownModels.includes(tag)) {
    form.value.knownModels = [...form.value.knownModels, tag];
  }
  newModelTag.value = "";
}
function removeModelTag(idx: number) {
  if (!form.value) return;
  form.value.knownModels = form.value.knownModels.filter((_, i) => i !== idx);
}
</script>

<template>
  <div class="provider-settings">
    <!-- Left: provider list -->
    <div class="provider-list">
      <div
        v-for="p in displayList"
        :key="p.id"
        class="provider-item"
        :class="{ active: selectedId === p.id }"
        @click="selectProvider(p.id)"
      >
        <span class="pi-icon"><ProviderLogo :kind="p.kind" :text="p.icon" :size="16" /></span>
        <div class="pi-info">
          <div class="pi-name">{{ p.name || "(未命名)" }}</div>
          <div v-if="p.modelMappings.anthropicModel || p.model" class="pi-model">
            {{ p.modelMappings.anthropicModel || p.model }}
          </div>
        </div>
        <span
          v-if="activeProviderId === p.id"
          class="pi-check"
          v-tooltip="'当前激活'"
        >
          ✓
        </span>
        <button
          v-else
          class="pi-activate"
          v-tooltip="'设为激活'"
          @click.stop="handleActivate(p.id)"
        >
          ○
        </button>
      </div>

      <button class="add-btn" @click="handleAdd">+ 添加供应商</button>
    </div>

    <!-- Right: edit form -->
    <div v-if="form" class="provider-form">
      <div class="form-scroll">
        <!-- SystemDefault 提示：认证走系统 env 兜底，仅配置模型变量与凭据 -->
        <div v-if="isSystemDefault" class="sys-default-hint">
          系统默认供应商：认证（API Key / Base URL 等）走系统环境变量兜底，此处可配置模型变量与凭据覆盖。
        </div>

        <!-- 名称：预置只读，Custom 可编辑 -->
        <div class="form-field">
          <label>名称</label>
          <input
            v-if="!isPreset"
            v-model="form.name"
            class="text-input"
            placeholder="如 DeepSeek"
          />
          <div v-else class="readonly-name">
            <ProviderLogo :kind="form.kind" :text="form.icon" :size="16" />
            <span>{{ form.name }}</span>
          </div>
        </div>

        <!-- 图标选择器：仅 Custom 可编辑（预置 kind 由 catalog 锁定 icon） -->
        <div v-if="!isPreset" class="form-field">
          <label>图标</label>
          <div class="icon-picker">
            <button
              v-for="g in PROVIDER_GLYPHS"
              :key="g"
              type="button"
              class="icon-picker-opt"
              :class="{ 'icon-picker-opt--active': form.icon === g }"
              v-tooltip="g"
              @click="form.icon = g"
            >
              <Icon :name="g" :size="18" />
            </button>
          </div>
        </div>

        <!-- Base URL：预置只读，Custom 可编辑 -->
        <div class="form-field">
          <label>Base URL</label>
          <input
            v-if="!isPreset"
            v-model="form.baseUrl"
            class="text-input"
            placeholder="https://api.example.com/anthropic"
          />
          <div v-else class="readonly-name">
            {{ form.baseUrl || "(Anthropic 官方端点)" }}
          </div>
          <span v-if="!isPreset" class="form-hint">
            第三方 Anthropic 兼容端点（GLM/DeepSeek/聚合站等）填这里；同时建议在下方填 Auth Token 而非 API Key
          </span>
        </div>

        <!-- 凭据区：按 auth_mode 渲染。预置只显示一个；Custom（isPreset=false）两个都显示 -->
        <div v-if="authMode === 'api_key' || !isPreset" class="form-field">
          <label>API Key</label>
          <input
            v-model="apiKeyInput"
            type="password"
            autocomplete="new-password"
            class="text-input"
            :placeholder="form.apiKeyConfigured ? '已配置；输入新值后替换' : '未配置；输入后保存'"
          />
          <div class="secret-state">
            <span>{{ form.apiKeyConfigured ? '已配置（不会回显）' : '未配置' }}</span>
            <button v-if="form.apiKeyConfigured" class="secret-clear-btn" @click="apiKeyMutation = { action: 'clear' }">清除</button>
            <button v-if="apiKeyMutation.action === 'clear'" class="secret-clear-btn" @click="apiKeyMutation = { action: 'unchanged' }">取消清除</button>
          </div>
          <span class="form-hint">
            对应 <code>x-api-key</code> 头。Anthropic 官方端点用这个；多数第三方端点用下方 Auth Token
          </span>
        </div>

        <div v-if="authMode === 'auth_token' || !isPreset" class="form-field">
          <label>Auth Token</label>
          <input
            v-model="authTokenInput"
            type="password"
            autocomplete="new-password"
            class="text-input"
            :placeholder="form.authTokenConfigured ? '已配置；输入新值后替换' : '未配置；输入后保存'"
          />
          <div class="secret-state">
            <span>{{ form.authTokenConfigured ? '已配置（不会回显）' : '未配置' }}</span>
            <button v-if="form.authTokenConfigured" class="secret-clear-btn" @click="authTokenMutation = { action: 'clear' }">清除</button>
            <button v-if="authTokenMutation.action === 'clear'" class="secret-clear-btn" @click="authTokenMutation = { action: 'unchanged' }">取消清除</button>
          </div>
          <span class="form-hint">
            对应 <code>Authorization: Bearer</code> 头。GLM/OpenAI 兼容等第三方端点通常填这里；与 API Key 二选一，同时填会以本字段为准
          </span>
        </div>

        <!-- 模型变量：5 个 Claude env 变量统一块。所有 provider 都可编辑。 -->
        <div class="form-section">
          <label>模型变量</label>
          <span class="form-hint">Claude 专属模型 env 变量，换 provider 时整块重写</span>

          <div class="form-field model-var-field">
            <label>默认模型</label>
            <input
              v-model="form.modelMappings.anthropicModel"
              class="text-input"
              list="known-models-list"
              placeholder="留空用 provider 默认"
            />
          </div>

          <div class="form-field model-var-field">
            <label>Opus 别名映射</label>
            <input
              v-model="form.modelMappings.defaultOpusModel"
              class="text-input"
              placeholder="留空不映射"
            />
          </div>

          <div class="form-field model-var-field">
            <label>Sonnet 别名映射</label>
            <input
              v-model="form.modelMappings.defaultSonnetModel"
              class="text-input"
              placeholder="留空不映射"
            />
            <span class="form-hint">子代理模型填 sonnet 别名时，用它解析成具体模型 id</span>
          </div>

          <div class="form-field model-var-field">
            <label>Haiku 别名映射</label>
            <input
              v-model="form.modelMappings.defaultHaikuModel"
              class="text-input"
              placeholder="留空不映射"
            />
            <span class="form-hint">子代理模型填 haiku 别名时，用它解析成具体模型 id</span>
          </div>

          <div class="form-field model-var-field">
            <label>子代理模型</label>
            <input
              v-model="form.modelMappings.subagent"
              class="text-input"
              list="known-models-list"
              placeholder="留空跟随主模型"
            />
            <span class="form-hint">主代理未指定模型时子代理的兜底，通常选便宜快的——主代理显式派发（如 sonnet）时以派发为准</span>
            <span class="form-hint">填具体模型 id 建议与上方某个别名映射保持一致；对不上别名的独立 id 会退回全局钉死（显式派发不生效）</span>
            <span class="form-hint">仅对当前激活的供应商生效——系统默认下填的不会作用到自定义供应商的会话</span>
          </div>
        </div>

        <!-- Effort Level：所有 provider 都显示（SystemDefault 现为正常 preset）。
             语义：新会话的默认档位——会话开始后由输入框工具栏的选择器接管（随时切换，
             即时生效）。这里的"默认"= 不在会话级覆盖，让 CLI/模型用自己的默认（high）。 -->
        <div class="form-field">
          <label>Effort Level（新会话默认）</label>
          <ThemedSelect
            :model-value="form.effortLevel"
            :options="effortOptions"
            block
            @update:model-value="form.effortLevel = $event"
          />
          <span class="form-hint">新开会话的初始档位；快速=关闭思考模式、思考/深度思考=开启；会话中可在输入框工具栏随时切换</span>
        </div>

        <!-- 自动压缩：CLAUDE_CODE_AUTO_COMPACT_WINDOW + CLAUDE_AUTOCOMPACT_PCT_OVERRIDE。
             空字段不注入 env，CLI 走自带默认。 -->
        <div class="form-section">
          <label>自动压缩</label>
          <span class="form-hint">模型上下文窗口与 auto-compact 阈值调优，留空走 CLI 默认</span>

          <div class="form-field model-var-field">
            <label>上下文窗口 (tokens)</label>
            <input
              v-model="form.maxContextTokens"
              class="text-input"
              type="number"
              min="1"
              placeholder="留空用 CLI 默认（未知模型 200K）"
            />
            <span class="form-hint">CLAUDE_CODE_MAX_CONTEXT_TOKENS：模型上下文窗口本身。填了可突破 CLI 对未知/非 Anthropic 模型的 200K 默认上限（压缩窗口被它夹住）；务必 ≤ 模型真实窗口——填超了 CLI 不再预压缩，但超出部分模型会截断或报错</span>
          </div>

          <div class="form-field model-var-field">
            <label>压缩窗口 (tokens)</label>
            <input
              v-model="form.autoCompactWindow"
              class="text-input"
              type="number"
              min="1"
              placeholder="留空用模型上下文窗口（200K/1M）"
            />
            <span class="form-hint">填 token 数（如 500000）提前触发压缩，上限为模型实际窗口</span>
          </div>

          <div class="form-field model-var-field">
            <label>触发百分比 (%)</label>
            <input
              v-model="form.autocompactPctOverride"
              class="text-input"
              type="number"
              min="1"
              max="100"
              placeholder="留空用 CLI 默认百分比"
            />
            <span class="form-hint">1–100，作用在窗口之上微调触发时机</span>
          </div>
        </div>

        <!-- 模型列表：会话面板模型下拉的数据源（真实模型 id，不做别名映射） -->
        <div class="form-section">
          <label>模型列表</label>
          <span class="form-hint">会话面板的模型下拉从这里取，填该供应商的真实模型 id</span>
          <div class="tags-area">
            <span
              v-for="(m, idx) in form.knownModels"
              :key="idx"
              class="model-tag"
            >
              {{ m }}
              <button class="tag-remove" @click="removeModelTag(idx)">×</button>
            </span>
            <input
              v-model="newModelTag"
              class="tag-input"
              placeholder="输入后回车添加"
              @keydown.enter.prevent="addModelTag"
            />
          </div>
        </div>

        <!-- 专属操作区：按 kind dispatch（Custom 不渲染） -->
        <ProviderActions v-if="selectedProvider" :provider="selectedProvider" />
      </div>

      <!-- Action buttons -->
      <div class="form-actions">
        <button v-if="!isSystemDefault" class="btn-delete" @click="handleDelete">
          删除
        </button>
        <button class="btn-save" @click="handleSave">保存</button>
      </div>
      <div class="respawn-hint">
        修改连接身份（Base URL / API Key / Auth Token）或模型变量后，正在运行的会话不会自动应用——需停止该会话后重新发送才会用上新配置。
      </div>
    </div>

    <!-- Empty state -->
    <div v-else class="provider-empty">
      <div class="empty-icon"><Icon name="provider" :size="32" /></div>
      <div class="empty-text">选择一个供应商进行编辑</div>
      <div class="empty-hint">或点击"+ 添加供应商"创建新的</div>
    </div>

    <!-- Toast 锚定在 .provider-settings（position: relative） -->
    <AToast :state="toastState" />
  </div>

  <ProviderCatalogPicker
    v-if="showPicker"
    @select="onPickerSelect"
    @select-custom="onPickerCustom"
    @cancel="showPicker = false"
  />

  <!-- 已知模型 datalist（子代理/默认模型输入的 autocomplete 源） -->
  <datalist id="known-models-list">
    <option v-for="m in form?.knownModels ?? []" :key="m" :value="m" />
  </datalist>
</template>

<style scoped>
.provider-settings {
  position: relative; /* AToast 锚定 */
  display: flex;
  height: 100%;
  gap: 0;
}

/* ── Left list ── */

.provider-list {
  width: 200px;
  flex-shrink: 0;
  border-right: 1px solid var(--aide-surface-default);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 4px;
}

.provider-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--aide-radius-md);
  cursor: pointer;
  transition: background 0.12s;
}

.provider-item:hover {
  background: var(--aide-surface-default);
}

.provider-item.active {
  background: var(--aide-surface-default);
}

.pi-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  width: 22px;
  flex-shrink: 0;
  color: var(--aide-accent);
}

.pi-info {
  flex: 1;
  min-width: 0;
}

.pi-name {
  font-size: 13px;
  color: var(--aide-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pi-model {
  font-size: 10px;
  color: var(--aide-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pi-check {
  color: var(--aide-success);
  font-size: 13px;
  flex-shrink: 0;
}

.pi-activate {
  background: none;
  border: 1px solid var(--aide-surface-hover);
  color: var(--aide-text-muted);
  font-size: 11px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  flex-shrink: 0;
  transition: all 0.12s;
}

.pi-activate:hover {
  border-color: var(--aide-success);
  color: var(--aide-success);
}

.add-btn {
  margin-top: 4px;
  padding: 8px 10px;
  border-radius: var(--aide-radius-md);
  border: 1px dashed var(--aide-surface-hover);
  background: transparent;
  color: var(--aide-text-secondary);
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  transition: all 0.12s;
}

.add-btn:hover {
  background: var(--aide-surface-default);
  border-color: var(--aide-accent);
  color: var(--aide-text-primary);
}

/* ── Right form ── */

.provider-form {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.form-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.form-scroll::-webkit-scrollbar {
  width: 4px;
}

.form-scroll::-webkit-scrollbar-thumb {
  background: var(--aide-surface-hover);
  border-radius: 2px;
}

.form-field label,
.form-section > label {
  display: block;
  font-size: 12px;
  color: var(--aide-text-secondary);
  margin-bottom: 4px;
}

.text-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--aide-bg-base);
  border: 1px solid var(--aide-surface-hover);
  border-radius: var(--aide-radius-sm);
  padding: 6px 10px;
  font-size: 13px;
  color: var(--aide-text-primary);
  outline: none;
  font-family: inherit;
  transition: border-color 0.15s;
}

.text-input::placeholder {
  color: var(--aide-text-muted);
}

.text-input:focus {
  border-color: var(--aide-accent);
}

select.text-input {
  cursor: pointer;
}

/* 预置只读字段：平铺非输入框外观 */
.readonly-name {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  color: var(--aide-text-primary);
  padding: 6px 0;
  word-break: break-all;
}

/* 图标选择器：6 个铜线字形候选，选中即设为 provider icon key。
 * 存量 emoji icon 仍由 IconOrChar 在列表里原样渲染，用户选一个字形即替换。 */
.icon-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.icon-picker-opt {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--aide-radius-sm);
  border: 1px solid var(--aide-border);
  background: var(--aide-bg-base);
  color: var(--aide-text-muted);
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s, background 0.12s;
}

.icon-picker-opt:hover {
  border-color: var(--aide-accent);
  color: var(--aide-accent);
}

.icon-picker-opt--active {
  border-color: var(--aide-accent);
  background: var(--aide-accent-subtle);
  color: var(--aide-accent);
}

.secret-state {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 5px;
  font-size: 11px;
  color: var(--aide-text-muted);
}

.secret-clear-btn {
  background: transparent;
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  color: var(--aide-text-secondary);
  cursor: pointer;
  font: inherit;
  padding: 2px 7px;
}

.secret-clear-btn:hover {
  border-color: var(--aide-danger);
  color: var(--aide-danger);
}

.form-section {
  border-top: 1px solid var(--aide-surface-default);
  padding-top: 10px;
}

.sys-default-hint {
  font-size: 11px;
  color: var(--aide-text-muted);
  background: var(--aide-surface-default);
  border-radius: var(--aide-radius-sm);
  padding: 8px 10px;
  line-height: 1.5;
}

/* 模型变量分组内的字段：比顶层字段略紧凑 */
.model-var-field {
  margin-top: 10px;
}

.model-var-field:first-of-type {
  margin-top: 4px;
}

.form-hint {
  display: block;
  font-size: 11px;
  color: var(--aide-text-muted);
  margin: 4px 0 6px;
}

/* ── Tags ── */

.tags-area {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px;
  background: var(--aide-bg-base);
  border: 1px solid var(--aide-surface-hover);
  border-radius: var(--aide-radius-sm);
  min-height: 32px;
  align-items: center;
}

.model-tag {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  background: var(--aide-surface-default);
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 11px;
  color: var(--aide-text-primary);
}

.tag-remove {
  background: none;
  border: none;
  color: var(--aide-text-muted);
  cursor: pointer;
  font-size: 12px;
  padding: 0 2px;
  line-height: 1;
}

.tag-remove:hover {
  color: var(--aide-danger);
}

.tag-input {
  border: none;
  background: transparent;
  outline: none;
  font-size: 11px;
  color: var(--aide-text-primary);
  min-width: 80px;
  flex: 1;
  font-family: inherit;
}

.tag-input::placeholder {
  color: var(--aide-text-muted);
}

/* ── Action buttons ── */

.form-actions {
  display: flex;
  justify-content: space-between;
  padding: 10px 16px;
  border-top: 1px solid var(--aide-surface-default);
  flex-shrink: 0;
}

.btn-delete {
  background: none;
  border: 1px solid color-mix(in srgb, var(--aide-danger) 30%, transparent);
  color: var(--aide-danger);
  padding: 6px 16px;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  transition: all 0.12s;
}

.btn-delete:hover {
  background: color-mix(in srgb, var(--aide-danger) 10%, transparent);
}

.btn-save {
  background: var(--aide-accent);
  border: none;
  color: var(--aide-bg-base);
  padding: 6px 24px;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  transition: all 0.12s;
}

.btn-save:hover {
  filter: brightness(1.1);
}

/* 编辑后需 respawn 才生效的提示 */
.respawn-hint {
  padding: 6px 16px 10px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--aide-text-muted);
  border-top: 1px solid var(--aide-surface-default);
}

/* ── Empty state ── */

.provider-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--aide-text-muted);
}

.empty-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--aide-accent);
  opacity: 0.6;
}

.empty-text {
  font-size: 13px;
}

.empty-hint {
  font-size: 11px;
}
</style>