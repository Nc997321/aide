<script setup lang="ts">
import { ref, watch } from "vue";
import { useProviders } from "../composables/useProviders";
import type { ProviderConfig, ProviderModelMappings } from "../types";

const {
  allProviders,
  activeProviderId,
  displayList,
  setActiveProvider,
  addProvider,
  updateProvider,
  deleteProvider,
  SYSTEM_DEFAULT_ID,
} = useProviders();

const selectedId = ref<string | null>(null);

const form = ref({
  name: "",
  icon: "",
  baseUrl: "",
  apiKey: "",
  authToken: "",
  model: "",
  opus: "",
  sonnet: "",
  haiku: "",
  subagent: "",
  effortLevel: "",
  knownModels: [] as string[],
});

const showApiKey = ref(false);
const showAuthToken = ref(false);
const newModelTag = ref("");
const showMappings = ref(false);

function loadForm(p: ProviderConfig) {
  form.value = {
    name: p.name,
    icon: p.icon,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    authToken: p.authToken,
    model: p.model,
    opus: p.modelMappings.opus,
    sonnet: p.modelMappings.sonnet,
    haiku: p.modelMappings.haiku,
    subagent: p.modelMappings.subagent,
    effortLevel: p.effortLevel,
    knownModels: [...p.knownModels],
  };
  showApiKey.value = false;
  showAuthToken.value = false;
  showMappings.value = false;
}

function selectProvider(id: string) {
  if (id === SYSTEM_DEFAULT_ID) {
    selectedId.value = null;
    return;
  }
  selectedId.value = id;
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
    opus: form.value.opus,
    sonnet: form.value.sonnet,
    haiku: form.value.haiku,
    subagent: form.value.subagent,
  };
  await updateProvider(selectedId.value, {
    name: form.value.name,
    icon: form.value.icon,
    baseUrl: form.value.baseUrl,
    apiKey: form.value.apiKey,
    authToken: form.value.authToken,
    model: form.value.model,
    modelMappings: mappings,
    effortLevel: form.value.effortLevel,
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
          title="当前激活"
        >
          ✓
        </span>
        <button
          v-if="p.id !== SYSTEM_DEFAULT_ID && activeProviderId !== p.id"
          class="pi-activate"
          title="设为激活"
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
        <div class="form-field">
          <label>名称</label>
          <input v-model="form.name" class="text-input" placeholder="如 DeepSeek" />
        </div>

        <div class="form-field">
          <label>图标</label>
          <input
            v-model="form.icon"
            class="text-input icon-input"
            maxlength="2"
            placeholder="单个 emoji"
          />
        </div>

        <div class="form-field">
          <label>Base URL</label>
          <input
            v-model="form.baseUrl"
            class="text-input"
            placeholder="https://api.example.com/anthropic"
          />
        </div>

        <div class="form-field">
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

        <div class="form-field">
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

        <div class="form-field">
          <label>模型名称</label>
          <input
            v-model="form.model"
            class="text-input"
            list="known-models-list"
            placeholder="如 deepseek-v4-pro"
          />
          <datalist id="known-models-list">
            <option
              v-for="m in knownModelsForDatalist()"
              :key="m"
              :value="m"
            />
          </datalist>
        </div>

        <div class="form-field">
          <label>Effort Level</label>
          <select v-model="form.effortLevel" class="text-input">
            <option value="">默认</option>
            <option value="LOW">LOW</option>
            <option value="MEDIUM">MEDIUM</option>
            <option value="HIGH">HIGH</option>
            <option value="MAX">MAX</option>
          </select>
        </div>

        <!-- Model mappings (collapsible) -->
        <div class="form-section">
          <button class="section-toggle" @click="showMappings = !showMappings">
            <span class="toggle-arrow" :class="{ open: showMappings }">▸</span>
            模型映射
          </button>

          <div v-if="showMappings" class="mapping-fields">
            <div class="mapping-row">
              <span class="mapping-label">Opus</span>
              <input v-model="form.opus" class="text-input" placeholder="留空不覆盖" />
            </div>
            <div class="mapping-row">
              <span class="mapping-label">Sonnet</span>
              <input v-model="form.sonnet" class="text-input" placeholder="留空不覆盖" />
            </div>
            <div class="mapping-row">
              <span class="mapping-label">Haiku</span>
              <input v-model="form.haiku" class="text-input" placeholder="留空不覆盖" />
            </div>
            <div class="mapping-row">
              <span class="mapping-label">Subagent</span>
              <input v-model="form.subagent" class="text-input" placeholder="留空不覆盖" />
            </div>
          </div>
        </div>

        <!-- Known models tags -->
        <div class="form-section">
          <label>已知模型</label>
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
        <button class="btn-delete" @click="handleDelete">删除</button>
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
  border-right: 1px solid var(--surface);
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
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s;
}

.provider-item:hover {
  background: var(--surface);
}

.provider-item.active {
  background: var(--surface);
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
  font-size: 12.5px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pi-model {
  font-size: 10px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pi-check {
  color: var(--accent-green);
  font-size: 13px;
  flex-shrink: 0;
}

.pi-activate {
  background: none;
  border: 1px solid var(--surface-hover);
  color: var(--text-muted);
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
  border-color: var(--accent-green);
  color: var(--accent-green);
}

.add-btn {
  margin-top: 4px;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px dashed var(--surface-hover);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  transition: all 0.12s;
}

.add-btn:hover {
  background: var(--surface);
  border-color: var(--accent);
  color: var(--text-primary);
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
  gap: 14px;
}

.form-scroll::-webkit-scrollbar {
  width: 4px;
}

.form-scroll::-webkit-scrollbar-thumb {
  background: var(--surface-hover);
  border-radius: 2px;
}

.form-field label,
.form-section > label {
  display: block;
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.text-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--bg-primary);
  border: 1px solid var(--surface-hover);
  border-radius: 5px;
  padding: 6px 10px;
  font-size: 12.5px;
  color: var(--text-primary);
  outline: none;
  font-family: inherit;
  transition: border-color 0.15s;
}

.text-input::placeholder {
  color: var(--text-muted);
}

.text-input:focus {
  border-color: var(--accent);
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
  border: 1px solid var(--surface-hover);
  border-radius: 5px;
  cursor: pointer;
  font-size: 13px;
  width: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s;
}

.eye-btn:hover {
  background: var(--surface);
}

/* ── Mappings ── */

.form-section {
  border-top: 1px solid var(--surface);
  padding-top: 10px;
}

.section-toggle {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  padding: 4px 0;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: color 0.12s;
}

.section-toggle:hover {
  color: var(--text-primary);
}

.toggle-arrow {
  font-size: 14px;
  transition: transform 0.15s;
  display: inline-block;
}

.toggle-arrow.open {
  transform: rotate(90deg);
}

.mapping-fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}

.mapping-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mapping-label {
  font-size: 11px;
  color: var(--text-muted);
  width: 56px;
  flex-shrink: 0;
}

.mapping-row .text-input {
  flex: 1;
}

/* ── Tags ── */

.tags-area {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px;
  background: var(--bg-primary);
  border: 1px solid var(--surface-hover);
  border-radius: 5px;
  min-height: 32px;
  align-items: center;
}

.model-tag {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  background: var(--surface);
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 11px;
  color: var(--text-primary);
}

.tag-remove {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  padding: 0 2px;
  line-height: 1;
}

.tag-remove:hover {
  color: var(--accent-red);
}

.tag-input {
  border: none;
  background: transparent;
  outline: none;
  font-size: 11px;
  color: var(--text-primary);
  min-width: 80px;
  flex: 1;
  font-family: inherit;
}

.tag-input::placeholder {
  color: var(--text-muted);
}

/* ── Action buttons ── */

.form-actions {
  display: flex;
  justify-content: space-between;
  padding: 10px 16px;
  border-top: 1px solid var(--surface);
  flex-shrink: 0;
}

.btn-delete {
  background: none;
  border: 1px solid rgba(243, 139, 168, 0.3);
  color: var(--accent-red);
  padding: 6px 16px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  transition: all 0.12s;
}

.btn-delete:hover {
  background: rgba(243, 139, 168, 0.1);
}

.btn-save {
  background: var(--accent);
  border: none;
  color: var(--bg-primary);
  padding: 6px 24px;
  border-radius: 5px;
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
  color: var(--text-muted);
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
