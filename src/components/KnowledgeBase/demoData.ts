// 演示数据：**不连服务器**也能把知识库的样子展示出来。
//
// 存在的理由：知识库是独立服务，没连上时前端只有一个登录框——
// 一个还没决定要不要用的人，看到"登录"只会关掉。这里给一份可点开、可检索的
// 样例，让他先知道自己在看什么，再决定加入还是自己搭。
//
// ⚠️ 这只是界面填充物，不是真实数据。任何一处改动都不该影响真实链路。
import type { KbDocument, KbSpace } from "./kbClient";

export const DEMO_SPACES: KbSpace[] = [
  {
    id: "demo-space-eng",
    key: "eng",
    name: "工程手册",
    description: "部署、排障、规范",
    visibility: "internal",
    role: "editor",
  },
  {
    id: "demo-space-product",
    key: "product",
    name: "产品文档",
    description: "需求与术语",
    visibility: "private",
    role: "viewer",
  },
];

export const DEMO_DOCS: KbDocument[] = [
  {
    id: "demo-doc-1",
    spaceId: "demo-space-eng",
    parentId: null,
    slug: "onboarding",
    title: "新人入职指南",
    versionNo: 7,
    status: "published",
    updatedAt: "2026-08-21T09:12:00Z",
    content: `# 新人入职指南

欢迎加入。这篇文档帮你把环境跑起来，第一天结束前应该能提交第一个改动。

## 第一天的三件事

1. 拿到代码仓库权限（找你的 mentor）
2. 按下面的步骤把本地环境跑通
3. 认领一个带 \`good first issue\` 标签的小任务

## 本地环境

\`\`\`bash
git clone git@git.internal:team/main.git
cd main
pnpm install
pnpm dev
\`\`\`

跑起来后访问 http://localhost:5173 。如果端口被占用，改 \`vite.config.ts\` 里的 \`server.port\`。

## 常见卡点

> **装依赖失败**：多半是 pnpm 版本太旧，先 \`corepack enable\` 再重试。

- [x] 领机器
- [x] 开账号
- [ ] 读完本文
- [ ] 提交第一个 PR

有卡住的地方直接问，不要自己耗超过半小时。`,
  },
  {
    id: "demo-doc-2",
    spaceId: "demo-space-eng",
    parentId: null,
    slug: "deploy",
    title: "服务部署手册",
    versionNo: 12,
    status: "published",
    updatedAt: "2026-09-02T14:30:00Z",
    content: `# 服务部署手册

生产环境部署走 CI，不要手工 scp 文件上去。

## 标准流程

1. 合并到 \`main\`
2. CI 自动构建镜像并推到内网仓库
3. 在发布平台点"部署"，选刚构建出的版本号
4. 观察 5 分钟指标，无异常再全量

## 回滚

发布平台保留最近 10 个版本。回滚就是重新部署上一个版本号：

\`\`\`bash
# 查看最近部署过的版本
deployctl history --service api --limit 10

# 回滚到指定版本
deployctl rollback --service api --to v1.42.0
\`\`\`

回滚**不会**回滚数据库迁移，需要回滚迁移时另外走 DBA。

## 灰度

新服务默认先放 5% 流量。指标看板在 Grafana 的 \`service/api\` 目录。

| 阶段 | 流量 | 观察时长 | 通过标准 |
| --- | --- | --- | --- |
| 灰度 | 5% | 30 分钟 | 错误率 < 0.1% |
| 半量 | 50% | 2 小时 | P99 无劣化 |
| 全量 | 100% | — | — |`,
  },
  {
    id: "demo-doc-3",
    spaceId: "demo-space-eng",
    parentId: null,
    slug: "api-style",
    title: "API 设计规范",
    versionNo: 4,
    status: "published",
    updatedAt: "2026-07-18T11:00:00Z",
    content: `# API 设计规范

## 命名

- 资源用**复数名词**：\`/api/documents\`，不要 \`/api/getDocument\`
- 层级不超过两层：\`/api/documents/{id}/revisions\` 可以，再深就该拆资源
- 字段一律 \`camelCase\`

## 错误响应

统一形状，\`message\` 是可以直接给用户看的中文：

\`\`\`json
{ "error": "not_found", "message": "文档不存在或已被删除" }
\`\`\`

| 状态码 | 用途 |
| --- | --- |
| 400 | 参数不合法，\`message\` 说明哪一项 |
| 401 | 未认证 |
| 403 | 已认证但权限不够 |
| 404 | 不存在，**或**无权知道它存在 |
| 409 | 冲突（如唯一键重复） |

> 404 与 403 的取舍：对不该知道资源存在的人返回 403 会泄露存在性。
> 拿不准就返回 404。

## 分页

游标分页，不用 offset——数据量大时 offset 会越来越慢。`,
  },
  {
    id: "demo-doc-4",
    spaceId: "demo-space-eng",
    parentId: null,
    slug: "troubleshooting-502",
    title: "故障排查：网关 502",
    versionNo: 3,
    status: "published",
    updatedAt: "2026-08-30T20:45:00Z",
    content: `# 故障排查：网关 502

## 先看什么

502 几乎总是**上游没起来**或者**起来又退了**，不是网关本身的问题。

\`\`\`bash
# 1. 上游进程在不在
systemctl status api

# 2. 端口有没有在听
ss -lntp | grep 8788

# 3. 最近有没有 OOM
dmesg -T | grep -i oom | tail -20
\`\`\`

## 三种常见成因

1. **发布后立刻 502**：新版本启动失败。看 \`journalctl -u api -n 200\`
2. **跑一段时间才 502**：多半是内存泄漏被 OOM killer 杀掉
3. **只有部分请求 502**：上游有实例健康检查失败，看注册中心

## 临时止血

重启能恢复，但**先留一份现场**再重启，否则查不到根因：

\`\`\`bash
jstack \$(pgrep -f api) > /tmp/thread-dump.txt
\`\`\``,
  },
  {
    id: "demo-doc-5",
    spaceId: "demo-space-product",
    parentId: null,
    slug: "requirement-review",
    title: "需求评审流程",
    versionNo: 2,
    status: "draft",
    updatedAt: "2026-09-05T16:20:00Z",
    content: `# 需求评审流程

## 什么时候需要评审

涉及以下任一情况必须走评审：

- 改动对外接口
- 影响支付 / 权限 / 数据删除
- 预计工期超过 3 人日

## 流程

1. 提前一天把方案文档发出来，参会的人**会前读完**
2. 会上只讨论异议，不复述文档
3. 结论当场写进文档的"决议"小节
4. 有异议未解决的，明确责任人与截止时间

## 文档模板

\`\`\`markdown
## 背景
## 目标与非目标
## 方案
## 备选方案与取舍
## 决议
\`\`\``,
  },
  {
    id: "demo-doc-6",
    spaceId: "demo-space-product",
    parentId: null,
    slug: "glossary",
    title: "术语表",
    versionNo: 1,
    status: "published",
    updatedAt: "2026-06-11T10:05:00Z",
    content: `# 术语表

同一个东西在不同文档里叫不同名字，是沟通成本的主要来源。以这里为准。

| 术语 | 含义 | 不要叫 |
| --- | --- | --- |
| 空间 Space | 文档的一级分组，权限的基本单位 | 项目、目录 |
| 文档 Document | 一篇内容，含多个版本 | 页面、文章 |
| 版本 Revision | 文档的一次保存快照 | 历史、记录 |
| 邀请链接 | 管理员发的一次性加入凭证 | 注册链接 |

> 新增术语请直接改这篇，不要另开文档。`,
  },
];

/** 演示模式下的检索：标题与正文里命中关键词即可，不做分词。 */
export function demoSearch(q: string, spaceId: string | null): {
  documentId: string;
  spaceId: string;
  title: string;
  versionNo: number;
  rank: number;
  snippet: string;
}[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];

  const pool = DEMO_DOCS.filter((d) => !spaceId || d.spaceId === spaceId);
  const hits: { doc: KbDocument; snippet: string }[] = [];

  for (const doc of pool) {
    const hay = `${doc.title}\n${doc.content}`.toLowerCase();
    const at = hay.indexOf(needle);
    if (at < 0) continue;
    // 取命中位置前后一段做摘要，与后端 ts_headline 的观感对齐
    const from = Math.max(0, at - 30);
    const raw = `${doc.title}\n${doc.content}`
      .slice(from, from + 140)
      .replace(/\s+/g, " ")
      .trim();
    const lower = raw.toLowerCase();
    const i = lower.indexOf(needle);
    const snippet =
      i < 0
        ? raw
        : `${raw.slice(0, i)}[[HL]]${raw.slice(i, i + needle.length)}[[/HL]]${raw.slice(i + needle.length)}`;
    hits.push({ doc, snippet: `${from > 0 ? "…" : ""}${snippet}…` });
  }

  return hits.map(({ doc, snippet }) => ({
    documentId: doc.id,
    spaceId: doc.spaceId,
    title: doc.title,
    versionNo: doc.versionNo,
    rank: doc.title.toLowerCase().includes(needle) ? 1 : 0.5,
    snippet,
  }));
}
