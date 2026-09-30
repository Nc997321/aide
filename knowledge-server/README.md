# aide-knowledge

团队共享知识库服务。定位与已拍板的约束（2026-09-06 拍板）：

- **团队共享**（10–30 人，偶尔撞车）→ 权限到文档级，版本历史可 diff 与回滚
- **部署形态 = 团队单点部署**：一台服务，全员连它，靠 `spaces` + `space_members` 分域。
  **不是多租户云**——schema 全程没有 `tenant_id`，也不打算加
- **使用人群 = 装了 aide 桌面端的人** → 入口在 aide 侧栏，不另起独立 web 应用
- **独立进程**，但前端代码在 aide 主仓库 `src/components/KnowledgeBase/`，
  直连本服务的 REST，**不走 aide-sdk 的 transport**（那套后端是 aide 的 Rust 命令）
- **先只做检索**（RAG 的 G 先砍掉），第一版只建全文倒排一路
- **全 Rust**，摄取管道也是 Rust

## 分层

```
src/port/       只定义 trait 与领域类型，禁止出现任何第三方库类型
src/adapter/    具体实现 —— 整个 crate 里唯一允许引用第三方库的地方
src/domain/     业务逻辑（权限/版本/锁/检索/摄取），只依赖 port
src/api/        HTTP 出口，只依赖 port + domain
src/main.rs     唯一的装配点
```

依赖方向永远朝内。全进程只有 `main.rs` 里两行 `Arc::new` 把具体实现接到端口上。

换解析库 / 换分词算法的改动面：adapter 下的一个文件 + 装配处一行。
`domain/` 与 `api/` 一行不动。这条红线的完整表述见仓库根 `CLAUDE.md`。

## 自托管（给团队用，一条命令起）

```bash
# 从 aide 仓库取两个文件，放到内网那台机器的任意空目录：
#   knowledge-server/docker-compose.yml
#   knowledge-server/.env.example

cp .env.example .env    # 改 DB_PASSWORD；KB_IMAGE 已有默认值，升级新版时再覆盖
docker compose up -d
```

compose 不含 `build:`——客户机器上没有源码，应用镜像从阿里云 ACR 拉
（默认钉在当前发布版本，`KB_IMAGE` 可覆盖）。
这一条会把 PostgreSQL 和知识库服务一起拉起来，不用单独装数据库。
默认监听 `8788`；浏览器先打开 `http://<host>:8788/api/health` 确认活没活。
数据库的端口**不映射到宿主机**，刻意只让 compose 内部能访问——排障时再加。

接下来在 aide 桌面端：

1. 打开侧栏「知识库」→ 登录卡片底部「服务地址」填这台机器的地址（改完失焦自动重连）
2. 第一次连上会让你**创建第一个管理员**，之后由他生成邀请链接给同事

### 镜像发布（客户不接触源码）

交付 compose 里没有 `build:`，应用镜像走阿里云 ACR 个人版
（`registry.example.com/aide/aide-knowledge`，
仓库内开发验证用 overlay 补 build）。⚠️ 域名是 2024-09 后个人版实例的 **crpi- 专属域名**
（访问凭证页复制），旧 `registry.cn-*.aliyuncs.com` 对新建实例已失效。
发布流程：

```bash
docker login registry.example.com   # 密码在 ACR 控制台「访问凭证」里设
./release.sh 0.5.0        # = build（带 KB_VERSION 构建参数）+ push 两个标签
```

**每次发布推两个标签，这是「用户侧升级命令一辈子不变」的全部机制**：

| 标签 | 语义 | 谁在用 |
|---|---|---|
| `:<版本号>`（如 `0.5.0`） | **不可变**。回滚、钉住某一版 | 用户想钉版本时写进 `.env` 的 `KB_IMAGE` |
| `:stable` | **移动**，每次都指向最新那版 | 交付的 `docker-compose.yml` 默认跟的就是它 |

于是**交付件不需要随版本改**（compose 里跟的是 `:stable`），用户侧那条命令也永远不变：

```bash
docker compose pull knowledge && docker compose up -d knowledge
```

⚠️ 规矩与理由：
- **版本号标签别覆盖重推**：已经拉过该标签的机器不会跟着换 digest，客户还得额外学一步
  `docker compose pull`。要发新东西就升版本号（`:stable` 是唯一有意移动的标签）。
- **版本号要注入镜像**（`release.sh` 的 `--build-arg KB_VERSION=`）：客户端拿它判断
  「服务端够不够新」，不够就在面板上提示用户升级、附带上面那条命令。不带这个参数构建
  出来的是 `dev`，客户端见了不提示（本地 `up -d --build` 就是这一档）。
- **升级提示不再依赖主动通知**：客户端自己会说。但大版本的行为变化仍建议知会一声。
- 客户侧拿到 `docker-compose.yml` + `.env.example`，改好 `DB_PASSWORD` 后
  `docker compose up -d` 即可；升级与回滚见下节。

**仓库内开发验证**用 overlay 补 build（交付文件不含它）：

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

### 客户侧升级与回滚

**就一条命令，不随版本变**（跟的是移动标签 `:stable`）：

```bash
docker compose pull knowledge && docker compose up -d knowledge
```

确认起来了：

```bash
docker compose logs --tail=50 knowledge
curl -s http://127.0.0.1:8788/api/health     # version 字段就是当前那版
```

客户端面板也会替你说话：服务端太旧时，面板顶部直接给出上面那条命令（可复制）。

- **升级只用 `up -d`，永远别加 `-v`**：`docker compose down -v` 会把 `pgdata`（数据库）与
  `kbdata`（附件）两个卷一起删掉 = 删库。手动 `docker rm -f` 容器同样没必要——`up -d`
  发现镜像 digest 变了会自己重建，只换容器不碰卷。
- `pull` 这一步**不能省**：跟的是移动标签 `:stable`，本地已经有同名镜像时 `up -d` 不会
  自己去比对远端 digest——不 pull 就永远停在旧那版（这也是为什么给用户的那条命令自带 `pull`）。
- 回滚 = 在 `.env` 里把 `KB_IMAGE` 钉成旧版本号 → `docker compose pull knowledge && docker compose up -d knowledge`。
  **能不能直接退，看这次发布有没有动 `migrations/`**：没动（纯 API / 客户端修正）可以直接退；
  动了就要意识到 schema 已经前进了——迁移在服务启动时执行（`src/main.rs` 的 `db::migrate`），
  sqlx 不会自己往回走。

  ⚠️ **0.4.0 → 0.3.0 退不回去**（006 带来的第一条硬约束）：006 把 `documents.title` 设成
  `NOT NULL`，而 0.3.0 的建文档 INSERT 压根不写这一列——退回旧镜像后**新建文档会直接失败**
  （NOT NULL 违例），而读文档不受影响，所以症状很迷惑：老文档都能打开、就是建不了新的。
  `kind` 那列没事（有 `DEFAULT 'doc'`）。要退就得连数据库一起退——升级前的 `pg_dump` 就是为此。

  ✅ **0.5.0 → 0.4.0 可以退**（007 只是加两列：`documents.mime` 带默认值、
  `revisions.search_text` 可空，旧版本忽略它们即可）。退回去之后只是新能力消失
  （网页条目看不见、取件地址 404），存量数据一个不丢；再升回来也不丢——这就是
  「加列可退、改列不可退」的那条线。

  升级**前**值得跑一次这条（只读，看一眼有没有会让 006 失败的孤儿行）：
  ```bash
  docker compose exec -T db psql -U aide -d aide_kb -t -c \
    "SELECT count(*) FROM documents WHERE current_revision_id IS NULL"
  ```
  结果是 `0` 就能升；非 `0` 说明库里有打不开的孤儿行，006 的 `SET NOT NULL` 会**故意让迁移
  整体失败**（服务起不来），先查清那些行是怎么来的。
- 升级前顺手备份（可选，两秒）：`docker compose exec -T db pg_dump -U aide aide_kb > kb-$(date +%F).sql`

**怎么确认新版真的生效**：`curl -s 127.0.0.1:8788/api/health` 里的 `version` 就是当前那版
（0.5.0 起才有这个字段；没有它就说明还在旧版）。它也是客户端判断「要不要提示用户升级」的依据。

### 内网给团队开放

把 compose 里的 `KB_HOST` 改成 `0.0.0.0`（默认已是），并配置 `KB_ALLOWED_CIDR`
只允许内网网段——见「网络准入」段。**别**在反代上把 `KB_ALLOWED_CIDR` 当身份认证用，
那是准入不是身份。

## 跑起来（开发用，需要本机 Rust）

**前提：需要一个 PostgreSQL 实例。** 本服务强依赖 PG——`tsvector` 生成列、GIN 索引、
`FOR UPDATE` 行锁都没有嵌入式替代品。原生 PostgreSQL 就够：`migrations/` 下的
自动迁移**不依赖任何扩展**。

```bash
cp .env.example .env          # 按需改 KB_DB_URL
cargo sqlx database create    # 可选，sqlx-cli
cargo run                     # 启动时自动应用 migrations/*.sql
```

默认端口 **8788**（`KB_PORT`）。⚠️ 别改回 8787——那是 `relay-server` 的端口
（`relay-server/src/main.rs:7`），aide 桌面端正跑着它，撞了服务起不来。

启动后会打出一句话说明应用了哪些迁移；`/api/health` 会回报实际装配的解析后端与分词器。

### 端到端冒烟

装完 PG（或 `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build`）
后一键验证后端主链路
（bootstrap → 邀请/加入 → 建空间 → 建文档 → 编辑锁 → 保存（含合并窗口）→ 回滚 → 检索 →
软删（级联子树 / 检索过滤 / 删后重建同名）→ 登出）：

```bash
./smoke.sh                   # 默认 http://127.0.0.1:8788，可传自定义地址
# 要求干净库；重复跑先 docker compose down -v
```

需要 curl 与 python（解析 JSON）。锁 TTL 过期抢占这类需要真实等待 300s 的行为不在覆盖范围。

### 向量检索是可选的

`migrations/optional/003_vector.sql` 需要 **pgvector**（不是 PG 自带，Windows 上要单独装），
所以它**不在自动迁移里**——`migrate()` 用 `read_dir` 扫描 `migrations/` 且不递归，
子目录扫不到。这样没装 pgvector 也能正常起服务。装好后手动执行：

```bash
psql "$KB_DB_URL" -f migrations/optional/003_vector.sql
# 补一行登记，避免以后重复执行
psql "$KB_DB_URL" -c "INSERT INTO _migrations (name) VALUES ('003_vector.sql')"
```

## 当前能力

### 条目 = 原件 + 派生可搜文本

库里的一篇东西是**条目**：一份内容 + 一个 mime + 一份可搜文本（`documents.mime` /
`revisions.search_text`）。

| 形态 | 原件 | 存法 | 目前收录 |
|---|---|---|---|
| **文本形态** | 本身就是文本 | `revisions.content` | `md` / `markdown` / `txt` / `html` / `htm` |
| **字节形态** | 字节（图片/pdf/…） | 由解析器抽成 markdown 后入库 | `docx` / `pdf` |

- **mime 由服务端按扩展名定，绝不采信客户端给的 `Content-Type`**（那是发送方自述）。
  docx / pdf 传进来会被解析成 markdown，所以它们的 mime **仍是 `text/markdown`**——
  mime 描述的是库里存的那份内容，不是上传的文件。
- **html 是文本形态**：原件原样存（agent 读到的、人编辑的都是这份源码），
  另派生一份剥掉标记的可搜文本用于检索（`domain/search_text.rs`，剥标记的规则只此一处）。
- 派生规则同时服务**写入**与**编辑保存**两条路——漏了后者会搜到旧内容。

### 会话有效期：滑动续期 + 绝对上限

- **滑动**（`KB_SESSION_TTL_HOURS`，默认 14 天）：一直在用就一直不用重新登录。
  到期前一个节流窗口内（24h）才会写库续期，不是每个请求都写。
- **绝对上限**（`KB_SESSION_HARD_TTL_HOURS`，默认 90 天）：钉在 `created_at` 上，
  续期推不动它。到点必须重新登录一次。

⚠️ 代价写在明处：滑动续期让**泄露的凭据「只要攻击者一直在用就不过期」**——
绝对上限就是给这一点兜底的。

## 网络准入：可选 IP 白名单

`KB_ALLOWED_CIDR`（逗号分隔 CIDR，留空=不限制）用来把外网挡在门外。

⚠️ 它是**准入**，不是**身份识别**：只回答"这个来源能不能访问"，
"来的是谁"仍由会话令牌决定。把 IP 当身份在 NAT（整个办公室一个出口 IP）、
DHCP（今天明天是两个人）、VPN（同一个人在另一个网段）下都会错乱。

取的是 TCP 对端地址，不是 `X-Forwarded-For`——那个头客户端能随便伪造。
真挂在反向代理后面，请在**代理**上做访问控制。
解析不出来（如 `/33`）会拒绝启动，而不是静默忽略这条规则。

## 鉴权：Bearer token，不是 cookie

`POST /api/auth/login` 返回 `{ token, user }`，前端存起来，之后每个请求带
`Authorization: Bearer <token>`。

不用 cookie 是**被 Tauri 逼出来的正确选择**： aide 桌面端的 WebView 页面 origin 是
`http://tauri.localhost`，与本服务不同源。跨站 cookie 会被 `SameSite=Lax` 挡掉；
改成 `SameSite=None` 又强制要求 `Secure`，而本机是 http——两条路都走不通。

Bearer 顺带带来：服务端无状态（查 `sessions` 表）、三种前端（Tauri WebView / 独立 web /
手机 PWA）共用同一套鉴权、不用碰浏览器 cookie 那套 `SameSite`/`Secure`/`credentials`
的相互作用。跨源通过 `KB_CORS_ALLOWED_ORIGINS` 放行。

## 账号：邀请制，没有注册入口

**刻意不做自助注册。** 私有化部署下服务地址就在客户内网，"谁能注册"等价于
"谁能进内网"，而 `internal`/`public` 空间对任何已登录用户可读——开放注册等于
把内网文档开给全公司。

流程是：空库 → 第一个访问者创建管理员（`bootstrap`）→ 管理员生成一次性邀请链接
（`invite`）→ 同事凭链接领取账号（`join`）。

邀请令牌**只存哈希**，明文只在生成那一次的响应里出现；链接用 hash 形态
（`http://host:8788/join#<token>`），贴进工单系统时 token 不会落到服务日志里。
停用是软停用（`is_active=false`）——`revisions.author_id` 还引用着他，删行会让
历史版本失去作者。

## 接口

| 域 | 接口 |
|---|---|
| 认证 | `GET /api/auth/status`、`POST /api/auth/bootstrap` `/login` `/join` `/logout`、`GET /api/auth/me` |
| 用户（管理员） | `GET /api/users`、`POST /api/users/invite`、`POST /api/users/{id}/revoke` |
| 空间 | `GET/POST /api/spaces`、`GET /api/spaces/{id}/documents` |
| 文档 | `POST /api/documents`、`GET/PUT /api/documents/{id}`、`DELETE /api/documents/{id}`（软删，连带整棵子树）、`GET /api/documents/{id}/revisions`、`POST /api/documents/{id}/revert` |
| 编辑锁 | `POST/DELETE /api/documents/{id}/lock`、`POST /api/documents/{id}/lock/heartbeat` |
| 检索 | `GET /api/search?q=&space_id=&limit=` |
| 摄取 | `POST /api/ingest?space_id=`、`GET /api/ingest/formats` |
| 预览取件 | `POST /api/documents/{id}/preview-token`（要 Bearer）、**`GET /p/{token}`（不要 Bearer）** |

### 取件地址（`/p/{token}`）

右栏内嵌浏览器**直接导航**过去，地址栏发不出 `Authorization` 头（与前端
`assetLoader.ts` 走 objectURL 是同一个原因）。所以预览口用**不透明 token** 鉴权：

- 由已登录用户为自己的某一份条目签出（判权沿用文档读权限），**只换得来那一份的只读字节**；
- 短时（10 分钟）、**只在内存里**——进程重启即全部失效，这是设计不是缺陷；
- 过期 / 未知 / 条目已删都是 404，文案写清「回资料库重新打开」。

第三步的**发布**会复用同一条通路，只是把票换成持久的那种（届时另加表，不是把这张改成落库）。

## 还没做

- 文档级 ACL 的读写接口（权限模型与合并逻辑已在 `domain/permission.rs`，只差出口）
- 向量检索（`migrations/optional/003_vector.sql` 已备好，等 pgvector 就位）
- 图片 / pdf / xlsx 作为**一等条目**（现在它们要么作为 md 附件、要么被抽成文本，
  原件不留）——“条目 = 原件 + 派生表示”的字节形态那一刀
- 标签 / 双链的读写接口（表已建）
- **回收站 / 恢复**：删除已是软删（`deleted_at`），但界面上没有入口——被删文档只能由
  管理员在库里 `UPDATE documents SET deleted_at = NULL` 捞回来。要做「已删列表 + 恢复」
  得新增一个列表端点（读路径现在全都过滤 `deleted_at IS NULL`）与一段 UI
- 删空的垃圾回收：`deleted_at` 置位后 `revisions` / `assets` 一直留着，没有清理任务

## 前端在哪

**aide 桌面端**：`src/components/KnowledgeBase/`，侧栏底部入口「知识库」。
它直连本服务的 REST，**不走 aide-sdk 的 transport**（那套的后端是 aide 的 Rust 命令）——
只沿用了 SDK 的工程约定（DTO 镜像 serde camelCase、门面平铺方法）与
`renderMarkdown` 这个纯工具函数。

可读可搜可编辑可删：文档编辑（编辑锁 + 30s 心跳 + 冲突禁存）、版本历史与回滚、
创建空间、删除（软删，确认弹窗里点明会连带删掉几篇子文档）均已落地；
编辑锁的状态机在 `src/composables/useKbDocLock.ts`（API 注入式，可脱离网络单测），
文档树的两种算法（侧栏层级 / 子树篇数）同在 `src/components/KnowledgeBase/docTree.ts`。
