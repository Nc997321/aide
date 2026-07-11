<script setup lang="ts">
import { ref, watch } from "vue";
import { useProviders } from "../composables/useProviders";
import ThemedSelect from "./ThemedSelect.vue";
import type { ProviderConfig, ProviderModelMappings } from "../types";

const effortOptions = [
  { value: "", label: "默认" },
  { value: "LOW", label: "LOW" },
  { value: "MEDIUM", label: "MEDIUM" },
  { value: "HIGH", label: "HIGH" },
  { value: "MAX", label: "MAX" },
];

const {
  allProviders,
  activeProviderId,
  displayList,
  setActiveProvider,
  addProvider,
  updateProvider,
  deleteProvider,
  saveSystemDefaultMappings,
  systemDefaultMappings,
  SYSTEM_DEFAULT_ID,
} = useProviders();

const selectedId = ref<string | null>(null);
// 是否在编辑系统默认——系统默认只配模型变量 5 字段，认证走系统 env 兜底，
// 故表单隐藏 name/icon/baseUrl/apiKey/authToken/模型列表/Effort。
const isSystemDefault = ref(false);

const form = ref({
  name: "",
  icon: "",
  baseUrl: "",
  apiKey: "",
  authToken: "",
  anthropicModel: "",
  defaultOpusModel: "",
  defaultSonnetModel: "",
  defaultHaikuModel: "",
  subagent: "",
  effortLevel: "",
  autoCompactWindow: "",
  autocompactPctOverride: "",
  knownModels: [] as string[],
});

const showApiKey = ref(false);
const showAuthToken = ref(false);
const newModelTag = ref("");

function loadForm(p: ProviderConfig) {
  // anthropicModel 兼容旧配置：权威源是 modelMappings.anthropicModel，旧配置只有
  // 顶层 model（Rust 端 migrate_provider_model 已迁移，这里 || p.model 兜底）
  form.value = {
    name: p.name,
    icon: p.icon,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    authToken: p.authToken,
    anthropicModel: p.modelMappings.anthropicModel || p.model,
    defaultOpusModel: p.modelMappings.defaultOpusModel,
    defaultSonnetModel: p.modelMappings.defaultSonnetModel,
    defaultHaikuModel: p.modelMappings.defaultHaikuModel,
    subagent: p.modelMappings.subagent,
    effortLevel: p.effortLevel,
    autoCompactWindow: p.autoCompactWindow,
    autocompactPctOverride: p.autocompactPctOverride,
    knownModels: [...p.knownModels],
  };
  showApiKey.value = false;
  showAuthToken.value = false;
}

function selectProvider(id: string) {
  if (id === SYSTEM_DEFAULT_ID) {
    // 系统默认：精简表单，只载入模型变量 5 字段
    selectedId.value = SYSTEM_DEFAULT_ID;
    isSystemDefault.value = true;
    const m = systemDefaultMappings.value;
    form.value = {
      name: "", icon: "", baseUrl: "", apiKey: "", authToken: "",
      anthropicModel: m.anthropicModel,
      defaultOpusModel: m.defaultOpusModel,
      defaultSonnetModel: m.defaultSonnetModel,
      defaultHaikuModel: m.defaultHaikuModel,
      subagent: m.subagent,
      effortLevel: "",
      autoCompactWindow: "",
      autocompactPctOverride: "",
      knownModels: [],
    };
    return;
  }
  selectedId.value = id;
  isSystemDefault.value = false;
  const p = allProviders.value.find((x) => x.id === id);
  if (p) loadForm(p);
}

async function handleAdd() {
  const p = await addProvider();
  selectedId.value = p.id;
  loadForm(p);
}

async function handleSave() {
  if (!selectedId.value) return;
  const mappings: ProviderModelMappings = {
    anthropicModel: form.value.anthropicModel,
    defaultOpusModel: form.value.defaultOpusModel,
    defaultSonnetModel: form.value.defaultSonnetModel,
    defaultHaikuModel: form.value.defaultHaikuModel,
    subagent: form.value.subagent,
  };
  if (isSystemDefault.value) {
    await saveSystemDefaultMappings(mappings);
    return;
  }
  await updateProvider(selectedId.value, {
    name: form.value.name,
    icon: form.value.icon,
    baseUrl: form.value.baseUrl,
    apiKey: form.value.apiKey,
    authToken: form.value.authToken,
    // model 顶层字段已废弃（权威源在 modelMappings.anthropicModel），这里同步写入
    // 仅为兼容侧栏 pi-model 显示，Rust 端不再读它
    model: form.value.anthropicModel,
    modelMappings: mappings,
    effortLevel: form.value.effortLevel,
    autoCompactWindow: form.value.autoCompactWindow,
    autocompactPctOverride: form.value.autocompactPctOverride,
    knownModels: form.value.knownModels,
  });
}

async function handleDelete() {
  if (!selectedId.value) return;
  const id = selectedId.value;
  selectedId.value = null;
  await deleteProvider(id);
}

async function handleActivate(id: string) {
  await setActiveProvider(id);
}

function addModelTag() {
  const tag = newModelTag.value.trim();
  if (tag && !form.value.knownModels.includes(tag)) {
    form.value.knownModels.push(tag);
  }
  newModelTag.value = "";
}

function removeModelTag(idx: number) {
  form.value.knownModels.splice(idx, 1);
}

// Known models from selected provider for datalist
function knownModelsForDatalist(): string[] {
  if (!selectedId.value) return [];
  const p = allProviders.value.find((x) => x.id === selectedId.value);
  return p?.knownModels ?? [];
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
        :class="{
          active: selectedId === p.id,
          'is-default': p.id === SYSTEM_DEFAULT_ID,
        }"
        @click="selectProvider(p.id)"
      >
        <span class="pi-icon">{{ p.icon }}</span>
        <div class="pi-info">
          <div class="pi-name">{{ p.name }}</div>
          <div v-if="p.model" class="pi-model">{{ p.model }}</div>
        </div>
        <span
          v-if="activeProviderId === p.id"
          class="pi-check"
          v-tooltip="'当前激活'"
        >
          ✓
        </span>
        <button
          v-if="p.id !== SYSTEM_DEFAULT_ID && activeProviderId !== p.id"
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
    <div v-if="selectedId" class="provider-form">
      <div class="form-scroll">
        <!-- 系统默认提示：系统默认认证走系统 env 兜底，不可配连接参数 -->
        <div v-if="isSystemDefault" class="sys-default-hint">
          系统默认供应商：认证（API Key / Base URL 等）走系统环境变量兜底，此处仅配置模型变量。
        </div>

        <div v-if="!isSystemDefault" class="form-field">
          <label>名称</label>
          <input v-model="form.name" class="text-input" placeholder="如 DeepSeek" />
        </div>

        <div v-if="!isSystemDefault" class="form-field">
          <label>图标</label>
          <input
            v-model="form.icon"
            class="text-input icon-input"
            maxlength="2"
            placeholder="单个 emoji"
          />
        </div>

        <div v-if="!isSystemDefault" class="form-field">
          <label>Base URL</label>
          <input
            v-model="form.baseUrl"
            class="text-input"
            placeholder="https://api.example.com/anthropic"
          />
        </div>

        <div v-if="!isSystemDefault" class="form-field">
          <label>API Key</label>
          <div class="secret-row">
            <input
              v-model="form.apiKey"
              :type="showApiKey ? 'text' : 'password'"
              class="text-input"
              placeholder="留空不设"
            />
            <button class="eye-btn" @click="showApiKey = !showApiKey">
              {{ showApiKey ? "🙈" : "👁" }}
            </button>
          </div>
        </div>

        <div v-if="!isSystemDefault" class="form-field">
          <label>Auth Token</label>
          <div class="secret-row">
            <input
              v-model="form.authToken"
              :type="showAuthToken ? 'text' : 'password'"
              class="text-input"
              placeholder="留空不设"
            />
            <button class="eye-btn" @click="showAuthToken = !showAuthToken">
              {{ showAuthToken ? "🙈" : "👁" }}
            </button>
          </div>
        </div>

        <!-- 模型变量：5 个 Claude env 变量统一块。自定义 provider 和系统默认都显示。 -->
        <div class="form-section">
          <label>模型变量</label>
          <span class="form-hint">Claude 专属模型 env 变量，换 provider 时整块重写</span>

          <div class="form-field model-var-field">
            <label>默认模型</label>
            <input
              v-model="form.anthropicModel"
              class="text-input"
              list="known-models-list"
              placeholder="留空用 provider 默认"
            />
          </div>

          <div class="form-field model-var-field">
            <label>Opus 别名映射</label>
            <input
              v-model="form.defaultOpusModel"
              class="text-input"
              placeholder="留空不映射"
            />
          </div>

          <div class="form-field model-var-field">
            <label>Sonnet 别名映射</label>
            <input
              v-model="form.defaultSonnetModel"
              class="text-input"
              placeholder="留空不映射"
            />
            <span class="form-hint">子代理模型填 sonnet 别名时，用它解析成具体模型 id</span>
          </div>

          <div class="form-field model-var-field">
            <label>Haiku 别名映射</label>
            <input
              v-model="form.defaultHaikuModel"
              class="text-input"
              placeholder="留空不映射"
            />
            <span class="form-hint">子代理模型填 haiku 别名时，用它解析成具体模型 id</span>
          </div>

          <div class="form-field model-var-field">
            <label>子代理模型</label>
            <input
              v-model="form.subagent"
              class="text-input"
              list="known-models-list"
              placeholder="留空跟随主模型"
            />
            <span class="form-hint">子代理（并行任务）单独用的模型，通常选便宜快的</span>
          </div>
        </div>

        <div v-if="!isSystemDefault" class="form-field">
          <label>Effort Level</label>
          <ThemedSelect v-model="form.effortLevel" :options="effortOptions" block />
        </div>

        <!-- 自动压缩：CLAUDE_CODE_AUTO_COMPACT_WINDOW + CLAUDE_AUTOCOMPACT_PCT_OVERRIDE。
             空字段不注入 env，CLI 走自带默认。仅自定义 provider 显示（与 Effort Level 一致）。 -->
        <div v-if="!isSystemDefault" class="form-section">
          <label>自动压缩</label>
          <span class="form-hint">Claude Code CLI auto-compact 阈值调优，留空走 CLI 默认</span>

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
        <div v-if="!isSystemDefault" class="form-section">
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
      </div>

      <!-- Action buttons -->
      <div class="form-actions">
        <button v-if="!isSystemDefault" class="btn-delete" @click="handleDelete">删除</button>
        <button class="btn-save" @click="handleSave">保存</button>
      </div>
    </div>

    <!-- Empty state -->
    <div v-else class="provider-empty">
      <div class="empty-icon">🧠</div>
      <div class="empty-text">选择一个供应商进行编辑</div>
      <div class="empty-hint">或点击"+ 添加供应商"创建新的</div>
    </div>
  </div>
</template>

<style scoped>
.provider-settings {
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
  font-size: 16px;
  width: 22px;
  text-align: center;
  flex-shrink: 0;
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

.icon-input {
  width: 60px;
  text-align: center;
  font-size: 16px;
}

.secret-row {
  display: flex;
  gap: 4px;
}

.secret-row .text-input {
  flex: 1;
}

.eye-btn {
  background: none;
  border: 1px solid var(--aide-surface-hover);
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  font-size: 13px;
  width: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s;
}

.eye-btn:hover {
  background: var(--aide-surface-default);
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
  font-size: 32px;
  opacity: 0.5;
}

.empty-text {
  font-size: 13px;
}

.empty-hint {
  font-size: 11px;
}
</style>
