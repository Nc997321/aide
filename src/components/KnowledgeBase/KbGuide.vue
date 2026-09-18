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

const props = defineProps<{
  /** 展示「部署服务」区块。只有登录页需要——能登录说明服务已经通了。 */
  deploy?: boolean;
}>();

const GUIDE_MD = `aide 知识库是团队**私有部署**的文档库：服务跑在自己内网，空间分域管理，全文检索，编辑加锁，每次保存留版本。这份指南内置于应用——还没连上服务器你也能看到它，这就是文档排样本来的样子。

## 空间与可见性

- 所有文档都归属**空间**。internal / public 空间对全体登录用户可读，private 只对受邀成员可见
- 左侧「空间」分组标题旁的 **+** 新建空间。**标识**是对外的稳定引用，建后不可改；**名称**随时可改——在那一行的 **⋯** 里
- 你在空间里的角色决定能不能写

## 目录树

- 空间里能建**任意层级的文件夹**，文档放在文件夹里
- 文件夹是纯容器：点它只展开或折叠，不会打开正文。空的文件夹会标一个「空」字
- **+** 是新建入口，两处都有：「文档」分组标题旁那个建在根目录，文件夹行悬停出现的那个建在这个文件夹里。点开都是「新建文件夹 / 新建文档」二选一
- **⋯** 里是这个节点自己的操作：重命名 / 移动到… / 删除。文档行没有新建入口——文档不能再往下挂
- **重命名不产生新版本**：改名只是改了它叫什么，正文的历史不受影响
- 删除文件夹会**连它里面的所有东西一起删**，而且**没有恢复入口**
- 折叠状态按空间记住，下次打开还是你离开时的样子
- 也可以让 agent 代劳：它能建文件夹、建文档、搬节点，但每次写操作都会先问你

## 写与改

- 打开文档点「编辑」会取得**编辑锁**，期间其他人不能同时修改；编辑结束或离开页面自动释放
- 每次保存生成一个**新版本**，短时间内的连续保存自动合并为同一版本
- 「历史」里可以查看任意版本并一键回滚；回滚本身也是一个新版本，不丢任何数据

## 找内容

- 顶栏搜索框即全文检索：中文分词、结果带命中片段、点击直达文档
- 点搜索结果时，侧栏会自动展开并滚到那一行

## 管理员须知

- 左下角「成员」页：邀请同事、吊销账号
- 邀请链接**一次性有效，7 天过期**。刻意没有自助注册——内网可达即门槛，账号一律由管理员分发`;

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
        <span class="kb-badge">内置</span>
        <span>随应用更新 · 不占空间</span>
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
        <li>镜像从 registry 拉，版本已钉在 compose 里。仓库为私有时先登录：<code>docker login registry.example.com</code></li>
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
/* 容器留白与 KbDocumentView 的 .kb-doc 一致，两处阅读栏宽相同 */
.kb-guide {
  height: 100%;
  overflow: auto;
  padding: 20px 26px 40px;
}
.kb-guide-head {
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--aide-border);
}
.kb-guide-head h1 {
  margin: 0 0 6px;
  font-size: 17px;
  font-weight: 600;
  color: var(--aide-text-primary);
  line-height: 1.4;
}
.kb-guide-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: var(--aide-text-muted);
}
.kb-badge {
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--aide-bg-deep);
  color: var(--aide-accent);
}

/* ── 部署区 ── */
.kb-deploy {
  margin: 0 0 22px;
  padding: 14px 16px;
  border: 1px solid var(--aide-border);
  border-radius: 10px;
  background: var(--aide-bg-deep);
}
.kb-deploy h2 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--aide-text-primary);
}
.kb-deploy h2 + ol { margin-top: 0; }
.kb-deploy ol,
.kb-deploy ul {
  margin: 8px 0;
  padding-left: 20px;
}
.kb-deploy li {
  font-size: 12px;
  line-height: 1.75;
  color: var(--aide-text-secondary, var(--aide-text-muted));
}
.kb-deploy code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--aide-bg-secondary);
  font-family: var(--aide-font-mono);
  font-size: 11px;
  color: var(--aide-text-primary);
}
.kb-cmd {
  margin: 6px 0 10px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--aide-bg-secondary);
  font-family: var(--aide-font-mono);
  font-size: 11px;
  color: var(--aide-text-primary);
  overflow-x: auto;
}
.kb-note {
  margin: 6px 0 0;
  font-size: 11px;
  line-height: 1.7;
  color: var(--aide-text-muted);
}
.kb-code-wrap {
  margin: 12px 0 4px;
  border: 1px solid var(--aide-border);
  border-radius: 8px;
  overflow: hidden;
}
.kb-code-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  background: var(--aide-bg-secondary);
  border-bottom: 1px solid var(--aide-border);
  font-size: 11px;
  font-family: var(--aide-font-mono);
  color: var(--aide-text-muted);
}
.kb-copy {
  border: 1px solid var(--aide-border);
  background: var(--aide-bg-primary);
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 11px;
  color: var(--aide-accent);
  cursor: pointer;
}
.kb-copy:hover {
  border-color: var(--aide-accent);
}
.kb-code {
  margin: 0;
  padding: 10px 12px;
  max-height: 260px;
  overflow: auto;
  background: var(--aide-bg-primary);
  font-family: var(--aide-font-mono);
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--aide-text-secondary, var(--aide-text-muted));
  white-space: pre;
}
</style>
