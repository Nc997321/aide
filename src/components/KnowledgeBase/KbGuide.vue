<script setup lang="ts">
/**
 * 内置《使用指南》——一篇随应用打包的真文档，不是营销卡片。
 *
 * 为什么存在：知识库的面板在"未登录"和"还没有文档"两种状态下最容易显得空。
 * WorkBuddy 资料库的做法是把介绍做成列表里可点开的文档——内容即产品样貌。
 * 这里照这个气质来：同一套 Markdown 渲染器（renderKbMarkdown）、同一套正文
 * 样式（msg-text）、同文档视图的容器留白，看起来就是一篇排版好的文档。
 *
 * 内容红线：只写真实存在的能力，不承诺还没做的；角色枚举等没核实过的
 * 细节不写具体值。
 *
 * 部署区（deploy=true，仅登录页用）：客户拿不到本仓库，所以交付物必须在这里给全——
 * docker-compose.yml 用 ?raw 从 knowledge-server/ 原样导入（单一来源，不抄第二份，
 * 改了 compose 这里自动跟着变），配一键复制。
 */
import { computed, ref } from "vue";
import { renderKbMarkdown } from "./markdown";
// Vite 的 ?raw：把交付给客户的 compose 原样打进包，避免前端另存一份导致漂移。
// 路径指向 knowledge-server/docker-compose.yml（仓库内唯一真源）。
import composeText from "../../../knowledge-server/docker-compose.yml?raw";
// 指南正文抽到 ./guideText —— 同一个动作「把使用指南存进资料库」也要用它，
// 文本只能有一份。
import { GUIDE_MD as GUIDE_MD_TEXT } from "./guideText";

const props = defineProps<{
  /** 展示「部署服务」区块。只有登录页需要——能登录说明服务已经通了。 */
  deploy?: boolean;
}>();

const GUIDE_MD = GUIDE_MD_TEXT;

const bodyHtml = computed(() => renderKbMarkdown(GUIDE_MD));

// ── 复制 compose ──
// 客户部署的第一步就是拿到这份文件。放在应用里可复制，就不用他去找仓库。
//  clipboard 在 WebView2 里通常可用；失败时明确告诉用户手动选中，不静默吞掉。
const copyState = ref<"idle" | "ok" | "fail">("idle");
async function copyCompose(): Promise<void> {
  try {
    await navigator.clipboard.writeText(composeText);
    copyState.value = "ok";
  } catch {
    copyState.value = "fail";
  }
  setTimeout(() => (copyState.value = "idle"), 2200);
}
</script>

<template>
  <article class="kb-guide">
    <header class="kb-guide-head">
      <h1>使用指南</h1>
      <div class="kb-guide-meta">
        <span>内置</span>
        <span>随应用更新</span>
      </div>
    </header>

    <section v-if="props.deploy" class="kb-deploy">
      <h2>部署服务</h2>
      <ol>
        <li>在要跑服务的机器上装好 Docker（Windows / macOS 装 Docker Desktop，Linux 装 Docker Engine + compose 插件）</li>
        <li>复制下面的 <code>docker-compose.yml</code>，在一个空目录里存成同名文件，然后执行：</li>
      </ol>
      <pre class="kb-cmd">docker compose up -d</pre>
      <p class="kb-note">
        这一条会拉起 PostgreSQL 与 knowledge-server，数据落在命名卷里（pgdata / kbdata），
        重启不丢。服务监听 <code>8788</code> 端口。
      </p>
      <p class="kb-note">回到左侧填「服务地址」：本机用 <code>http://127.0.0.1:8788</code>，团队共用则填那台机器的内网 IP。</p>

      <div class="kb-code-wrap">
        <div class="kb-code-head">
          <span>docker-compose.yml</span>
          <button class="kb-copy" type="button" @click="copyCompose()">
            {{ copyState === "ok" ? "已复制" : copyState === "fail" ? "复制失败，请手动选中" : "复制" }}
          </button>
        </div>
        <pre class="kb-code">{{ composeText }}</pre>
      </div>

      <h2>部署须知</h2>
      <ul>
        <li>镜像从 registry 拉，compose 跟的是<strong>移动标签</strong>，所以升级就一条命令（不随版本变）：<code>docker compose pull knowledge &amp;&amp; docker compose up -d knowledge</code>。要钉住某一版 / 回滚，在 <code>.env</code> 里写 <code>KB_IMAGE=…:0.5.0</code></li>
        <li>仓库为私有时先登录：<code>docker login registry.example.com</code></li>
        <li>默认数据库口令是 <code>aide</code>，上生产建议改：同目录建 <code>.env</code>，写 <code>DB_PASSWORD=你的口令</code> 后重启</li>
        <li>8788 端口要对客户端可达；跨域来源默认只放行 aide 桌面端，浏览器直连需改 <code>KB_CORS_ALLOWED_ORIGINS</code></li>
        <li>需要向量检索时把 db 镜像换成 <code>pgvector/pgvector:pg17</code>，再手动执行 <code>migrations/optional/003_vector.sql</code></li>
      </ul>
    </section>

    <!-- v-html 的内容来自 renderKbMarkdown，已做默认拒绝处理，见 ./markdown.ts -->
    <div class="kb-guide-body msg-text" v-html="bodyHtml" />
  </article>
</template>

<style scoped>
/* 与 KbDocumentView 同一套阅读栏：720px 居中竖轴、26px 标题、14/1.8 正文。
   两处若分叉，用户在「指南 ⇄ 文档」之间来回切时会看出来。 */

.kb-guide {
  height: 100%;
  overflow: auto;
  padding: 40px 24px 88px;
}
.kb-guide > * {
  max-width: 720px;
  margin-left: auto;
  margin-right: auto;
}
.kb-guide-head {
  margin-bottom: 32px;
}
.kb-guide-head h1 {
  margin: 0 0 10px;
  font-size: 26px;
  font-weight: 600;
  line-height: 1.25;
  letter-spacing: -0.01em;
  color: var(--aide-text-primary);
}
.kb-guide-meta {
  display: flex;
  align-items: baseline;
  gap: 14px;
  font-size: 11.5px;
  color: var(--aide-text-muted);
}

/* ── 部署区（只有登录页会渲染它）── */
.kb-deploy {
  /* 只写下方：左右交给 `.kb-guide > *` 的 auto 居中 */
  margin-bottom: 32px;
  padding: 16px 20px;
  border-radius: var(--aide-radius-md);
  background: var(--aide-bg-raised);
}
.kb-deploy h2 {
  margin: 0 0 10px;
  font-size: 15px;
  font-weight: 600;
  color: var(--aide-text-primary);
}
.kb-deploy h2 + ol { margin-top: 0; }
.kb-deploy ol,
.kb-deploy ul {
  margin: 10px 0;
  padding-left: 20px;
}
.kb-deploy li {
  font-size: 13px;
  line-height: 1.8;
  color: var(--aide-text-secondary);
  margin: 5px 0;
}
.kb-deploy code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--aide-bg-deep);
  font-family: var(--aide-font-mono);
  font-size: 12px;
  color: var(--aide-text-primary);
}
.kb-cmd {
  margin: 8px 0 12px;
  padding: 10px 12px;
  border-radius: var(--aide-radius-sm);
  background: var(--aide-bg-deep);
  font-family: var(--aide-font-mono);
  font-size: 12px;
  color: var(--aide-text-primary);
  overflow-x: auto;
}
.kb-note {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.8;
  color: var(--aide-text-muted);
}
.kb-code-wrap {
  margin: 16px 0 8px;
  border-radius: var(--aide-radius-sm);
  overflow: hidden;
  background: var(--aide-bg-raised);
}
.kb-code-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--aide-border-subtle);
  font-size: 11.5px;
  font-family: var(--aide-font-mono);
  color: var(--aide-text-muted);
}
.kb-copy {
  border: none;
  background: var(--aide-surface-default);
  border-radius: var(--aide-radius-sm);
  padding: 4px 10px;
  font: inherit;
  font-size: 11.5px;
  color: var(--aide-text-secondary);
  cursor: pointer;
  transition: background var(--aide-ease-t), color var(--aide-ease-t);
}
.kb-copy:hover { background: var(--aide-surface-hover); color: var(--aide-text-primary); }
.kb-copy:focus-visible { outline: none; box-shadow: var(--aide-accent-ring); }
.kb-code {
  margin: 0;
  padding: 12px 14px;
  max-height: 260px;
  overflow: auto;
  background: var(--aide-bg-deep);
  font-family: var(--aide-font-mono);
  font-size: 12px;
  line-height: 1.7;
  color: var(--aide-text-secondary);
  white-space: pre;
}

/* ── 正文（.msg-text 的阅读面覆写，与 KbDocumentView 同一套节奏）── */
.kb-guide-body { font-size: 14px; line-height: 1.8; color: var(--aide-text-primary); }
.kb-guide-body :deep(h1),
.kb-guide-body :deep(h2),
.kb-guide-body :deep(h3),
.kb-guide-body :deep(h4) {
  margin: 32px 0 12px;
  font-weight: 600;
  line-height: 1.35;
  letter-spacing: -0.005em;
  color: var(--aide-text-primary);
}
.kb-guide-body :deep(h3),
.kb-guide-body :deep(h4) { margin: 24px 0 8px; }
.kb-guide-body :deep(h1) { font-size: 22px; }
.kb-guide-body :deep(h2) { font-size: 17px; }
.kb-guide-body :deep(h3) { font-size: 15px; }
.kb-guide-body :deep(h4) { font-size: 14px; }
.kb-guide-body :deep(> *:first-child) { margin-top: 0; }
.kb-guide-body :deep(p) { margin: 0 0 16px; }
.kb-guide-body :deep(ul),
.kb-guide-body :deep(ol) { margin: 12px 0 16px; padding-left: 22px; }
.kb-guide-body :deep(li) { margin: 5px 0; }
</style>
