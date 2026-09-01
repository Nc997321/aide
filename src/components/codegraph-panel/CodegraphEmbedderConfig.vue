<script setup lang="ts">
// CodeGraph embedding 后端配置（自 SettingsPanel「代码索引」tab 迁入，逻辑原样）。
// 整块写入：任一字段变动都把完整的 codegraphEmbedder 回写后端。下次 build
// 读新配置；model_name/dim 变 → meta 不匹配 → 自动全量重建（KISS，无 reinit 命令）。
import { ref, watch } from "vue";
import { useSettings } from "../../composables/useSettings";
import type { SecretMutation } from "../../types";
import ThemedSelect from "../ThemedSelect.vue";
import Icon from "../Icon.vue";
import { AButton } from "../../ui";

const { settings, setCodegraphEmbedder } = useSettings();

const cgBackendOptions = [
  { value: "fastembed", label: "fastembed（本地 ONNX）" },
  { value: "http", label: "HTTP（Ollama / 云端）" },
];
const cgFormatOptions = [
  { value: "ollama", label: "ollama（/api/embed）" },
  { value: "openai", label: "openai（/v1/embeddings）" },
];

const cgBackend = ref(settings.codegraphEmbedder.backend);
const cgBaseUrl = ref(settings.codegraphEmbedder.baseUrl);
// Credentials never join the global settings singleton: this is always blank on load.
const cgApiKey = ref("");
const cgModel = ref(settings.codegraphEmbedder.model);
const cgFormat = ref(settings.codegraphEmbedder.format);
const cgDim = ref(settings.codegraphEmbedder.dim);
// undefined = 后端按模型自动（fastembed≈0.35，http≈0.55）；用户填了数字则覆盖。
const cgScoreThreshold = ref<number | undefined>(settings.codegraphEmbedder.scoreThreshold);

function codegraphConfig() {
  return {
    backend: cgBackend.value,
    baseUrl: cgBaseUrl.value,
    apiKeyConfigured: settings.codegraphEmbedder.apiKeyConfigured,
    model: cgModel.value,
    format: cgFormat.value,
    dim: cgDim.value,
    scoreThreshold: cgScoreThreshold.value,
  } as const;
}

function flushCodegraphEmbedder() {
  void setCodegraphEmbedder(codegraphConfig());
}

async function saveCodegraphApiKey() {
  const value = cgApiKey.value;
  const mutation: SecretMutation = value ? { action: "set", value } : { action: "unchanged" };
  await setCodegraphEmbedder(codegraphConfig(), mutation);
  cgApiKey.value = "";
}

async function clearCodegraphApiKey() {
  await setCodegraphEmbedder(codegraphConfig(), { action: "clear" });
  cgApiKey.value = "";
}

// 空输入 = undefined（后端按模型自动）；v-model.number 会把空串 coerce 成 0、丢失"自动"
// 语义，所以手绑 :value/@input。非法/负数归零为 undefined。
function onScoreThresholdInput(e: Event) {
  const el = e.target as HTMLInputElement;
  cgScoreThreshold.value = el.value === "" ? undefined : Number.parseFloat(el.value);
}
watch(cgBackend, flushCodegraphEmbedder);
watch(cgBaseUrl, flushCodegraphEmbedder);
watch(cgModel, flushCodegraphEmbedder);
watch(cgFormat, flushCodegraphEmbedder);
watch(cgDim, (v) => {
  const clamped = Math.max(0, Math.floor(v) || 0);
  cgDim.value = clamped;
  flushCodegraphEmbedder();
});
watch(cgScoreThreshold, (v) => {
  if (v !== undefined && (Number.isNaN(v) || v < 0)) cgScoreThreshold.value = undefined;
  flushCodegraphEmbedder();
});
</script>

<template>
  <div class="cg-embedder">
    <div class="cg-section-label">Embedding 后端（本机全局配置）</div>

    <div class="settings-field">
      <label class="field-label">后端</label>
      <ThemedSelect
        :model-value="cgBackend"
        :options="cgBackendOptions"
        @update:model-value="(v: string) => (cgBackend = v as 'fastembed' | 'http')"
      />
      <span class="field-hint">
        fastembed = 本地 ONNX 离线推理（首次会下载模型）；http = Ollama / OpenAI 兼容云端，速度更快
      </span>
    </div>

    <template v-if="cgBackend === 'http'">
      <div class="settings-field">
        <label class="field-label">API 格式</label>
        <ThemedSelect
          :model-value="cgFormat"
          :options="cgFormatOptions"
          @update:model-value="(v: string) => (cgFormat = v as 'ollama' | 'openai')"
        />
        <span class="field-hint">
          ollama：原生 /api/embed（本地或远程 Ollama）；openai：/v1/embeddings（OpenAI / Jina 等兼容）
        </span>
      </div>

      <div class="settings-field">
        <label class="field-label">服务地址</label>
        <input
          v-model="cgBaseUrl"
          class="text-input"
          placeholder="http://localhost:11434（Ollama）或 https://api.openai.com"
        />
        <span class="field-hint">Ollama 本地默认 http://localhost:11434，也支持远程 HTTP 地址</span>
      </div>

      <div class="settings-field">
        <label class="field-label">API Key</label>
        <input
          v-model="cgApiKey"
          class="text-input"
          type="password"
          autocomplete="new-password"
          :placeholder="settings.codegraphEmbedder.apiKeyConfigured ? '已配置；输入新值后替换' : 'OpenAI / Jina 必填；Ollama 原生可空'"
        />
        <div class="cg-secret-actions">
          <span class="field-hint">{{ settings.codegraphEmbedder.apiKeyConfigured ? '已配置（密钥不会回显）' : '未配置' }}</span>
          <AButton size="sm" :disabled="!cgApiKey" @click="saveCodegraphApiKey">替换</AButton>
          <AButton v-if="settings.codegraphEmbedder.apiKeyConfigured" size="sm" @click="clearCodegraphApiKey">清除</AButton>
        </div>
      </div>

      <div class="settings-field">
        <label class="field-label">模型</label>
        <input
          v-model="cgModel"
          class="text-input"
          placeholder="nomic-embed-text（Ollama）/ text-embedding-3-small（OpenAI）"
        />
      </div>

      <div class="settings-field">
        <label class="field-label">向量维度</label>
        <div class="field-control">
          <input
            v-model.number="cgDim"
            type="number"
            min="0"
            class="text-input"
          />
          <span class="field-hint">0 = 自动从首次响应探测；nomic-embed-text=768，text-embedding-3-small=1536</span>
        </div>
      </div>
    </template>

    <div class="settings-field">
      <label class="field-label">语义搜索分数阈值</label>
      <div class="field-control">
        <input
          :value="cgScoreThreshold"
          @input="onScoreThresholdInput"
          type="number"
          min="0"
          max="1"
          step="0.05"
          class="text-input"
          placeholder="自动"
        />
        <span class="field-hint">留空 = 后端按模型自动（fastembed≈0.35，http≈0.55）；范围 0~1，改后立即生效、无需重建索引</span>
      </div>
    </div>

    <div class="cg-rebuild-note">
      <Icon name="warning" :size="13" />
      切换后端或模型会触发全量重建索引（向量维度 / 模型空间不兼容）。
    </div>
  </div>
</template>

<style scoped>
.cg-section-label {
  display: block;
  font-size: 12px;
  color: var(--aide-text-muted);
  margin: 24px 0 12px;
  padding-top: 16px;
  border-top: 1px solid var(--aide-border);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.settings-field {
  margin-bottom: 16px;
}
.settings-field:last-child {
  margin-bottom: 0;
}

.field-label {
  display: block;
  font-size: 13px;
  color: var(--aide-text-primary);
  margin-bottom: 6px;
  font-weight: 500;
}

.field-hint {
  display: block;
  margin-top: 5px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--aide-text-muted);
}

/* 数字输入 + 提示：窄侧栏里不并排硬挤，输入一行、提示整行换行到下方 */
.field-control {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
}

.field-control .text-input {
  width: 100px;
  flex-shrink: 0;
}

.field-control .field-hint {
  margin-top: 0;
  flex: 1;
  min-width: 120px;
}

.text-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--aide-bg-base);
  border: 1px solid var(--aide-surface-hover);
  border-radius: var(--aide-radius-md);
  padding: 8px 12px;
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

.cg-secret-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.cg-secret-actions .field-hint {
  margin-top: 0;
  flex: 1;
  min-width: 0;
}

.cg-info {
  margin-top: 4px;
  margin-bottom: 16px;
}

.cg-rebuild-note {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: var(--aide-radius-md);
  background: color-mix(in srgb, var(--aide-warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--aide-warning) 25%, transparent);
  font-size: 11px;
  color: var(--aide-warning);
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>