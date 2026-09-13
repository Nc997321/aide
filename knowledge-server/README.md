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
./release.sh 0.2.1                               # = docker build + push（例：新版本号，标签随版本走）
```

推完**再**同步 compose 里 knowledge 服务默认镜像的标签（脚本末尾会提醒）。
⚠️ 顺序不能反：**先 push 再改标签**——反过来新拿到 compose 的客户会去拉一个不存在的 tag。
**别用旧标签覆盖重推**：已经拉过该标签的机器不会跟着换 digest，客户还得额外学一步
`docker compose pull`。发完记得**主动通知客户**（没有更新检查机制），并附上 `.env` 里那行
`KB_IMAGE`——老客户手里那份 compose 是交付时下载的，默认标签停在那一版，不写这行就永远
停在那一版。客户侧拿到 `docker-compose.yml` + `.env.example`，改好 `DB_PASSWORD` 后
`docker compose up -d` 即可；升级与回滚见下节。

**仓库内开发验证**用 overlay 补 build（交付文件不含它）：

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

### 客户侧升级与回滚

```bash
# 1) 在 .env 里改/加一行，指向新标签
KB_IMAGE=registry.example.com/aide/aide-knowledge:0.2.1

# 2) 拉应用镜像（db 没变，不用拉）
docker compose pull knowledge

# 3) 重建（不需要先删容器，也不需要 down）
docker compose up -d knowledge

# 4) 确认起来了
docker compose logs --tail=50 knowledge
curl -s http://127.0.0.1:8788/api/health
```

- **升级只用 `up -d`，永远别加 `-v`**：`docker compose down -v` 会把 `pgdata`（数据库）与
  `kbdata`（附件）两个卷一起删掉 = 删库。手动 `docker rm -f` 容器同样没必要——`up -d`
  发现镜像 digest 变了会自己重建，只换容器不碰卷。
- 第 2 步在**换标签**时可省（新标签本地没有，`up -d` 会自己拉）。它只在「同一个标签被重新
  推过、远端 digest 变了」时必要——而发布约定就是不覆盖旧标签，所以那个场面不该出现。
- 回滚 = 把 `KB_IMAGE` 改回旧标签 → `docker compose pull knowledge && docker compose up -d knowledge`。
  **能不能直接退，看这次发布有没有动 `migrations/`**：没动（纯 API / 客户端修正）可以直接退；
  动了就要意识到 schema 已经前进了——迁移在服务启动时执行（`src/main.rs` 的 `db::migrate`），
  sqlx 不会自己往回走。
- 升级前顺手备份（可选，两秒）：`docker compose exec -T db pg_dump -U aide aide_kb > kb-$(date +%F).sql`

**怎么确认新版真的生效**：health 端点只报 status / parsers / tokenizer，**不报版本**——判据
是行为（比如换了上传上限的版本，拿一个刚过大小的文件试导入），或看 `docker compose ps`
里 knowledge 服务的镜像 tag / digest。

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
（bootstrap → 邀请/加入 → 建空间 → 建文档 → 编辑锁 → 保存（含合并窗口）→ 回滚 → 检索 → 登出）：

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
| 文档 | `POST /api/documents`、`GET/PUT /api/documents/{id}`、`GET /api/documents/{id}/revisions`、`POST /api/documents/{id}/revert` |
| 编辑锁 | `POST/DELETE /api/documents/{id}/lock`、`POST /api/documents/{id}/lock/heartbeat` |
| 检索 | `GET /api/search?q=&space_id=&limit=` |
| 摄取 | `POST /api/ingest?space_id=`、`GET /api/ingest/formats` |

## 还没做

- 文档级 ACL 的读写接口（权限模型与合并逻辑已在 `domain/permission.rs`，只差出口）
- 向量检索（`migrations/optional/003_vector.sql` 已备好，等 pgvector 就位）
- 摄取管道的 UI（接口已有，docx/pdf 导入目前靠 curl / psql 手动走）
- 标签 / 双链的读写接口（表已建）

## 前端在哪

**aide 桌面端**：`src/components/KnowledgeBase/`，侧栏底部入口「知识库」。
它直连本服务的 REST，**不走 aide-sdk 的 transport**（那套的后端是 aide 的 Rust 命令）——
只沿用了 SDK 的工程约定（DTO 镜像 serde camelCase、门面平铺方法）与
`renderMarkdown` 这个纯工具函数。

可读可搜可编辑：文档编辑（编辑锁 + 30s 心跳 + 冲突禁存）、版本历史与回滚、
创建空间均已落地；编辑锁的状态机在 `src/composables/useKbDocLock.ts`（API 注入式，
可脱离网络单测）。
