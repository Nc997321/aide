-- 001_init.sql — 核心表结构
--
-- 只依赖 PostgreSQL 14+ 的内置能力（gen_random_uuid 自 13 起内置），不依赖任何扩展。
-- 中文分词与向量检索在 002_search.sql 中叠加，缺扩展也不影响本文件跑通。
--
-- ⚠️ 事务由 src/db.rs 的 migrate() 统一包裹，本文件内不要写 BEGIN / COMMIT。

-- 邀请制：**没有自助注册入口**。账号由管理员创建，被邀请人凭一次性链接领取。
-- 所以 email 与 password_hash 都可空——没人填邮箱，成员也没有口令。
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 唯一标识。内部团队 10-30 人，由管理员保证不重名
  username      text NOT NULL,
  email         text,
  -- 只有初始化时设过口令的管理员才有；凭链接加入的成员为 NULL
  password_hash text,
  display_name  text NOT NULL,
  -- 全局角色，与 space_members.role 是两回事：
  -- 这里管「能不能建空间、能不能邀请人」，那边管「在某个空间里能做什么」
  is_admin      boolean NOT NULL DEFAULT false,
  avatar_url    text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz
);
-- 不区分大小写。用表达式索引而不是 citext，少一个扩展依赖。
CREATE UNIQUE INDEX users_username_lower_uidx ON users (lower(username));
-- 带 WHERE 的部分索引：SQL 的 UNIQUE 本就认为 NULL 互不相同（多个空邮箱可以共存），
-- 写出来是为了让这个意图显式可见，顺带索引更小。
CREATE UNIQUE INDEX users_email_lower_uidx ON users (lower(email)) WHERE email IS NOT NULL;

-- ⚠️ 用户实际上是**不可删除**的，这是有意的，不是遗漏。
-- sessions / space_members / document_acl / document_locks / invitations.created_by
-- 对 users 都是 CASCADE，但 spaces.owner_id、documents.created_by、revisions.author_id
-- 用的是默认的 NO ACTION —— 只要这个人建过空间或文档，DELETE 就会失败。
-- 停用成员走 is_active = false（README「账号」节），历史版本因此不会失去作者。

CREATE TABLE sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  user_agent text,
  ip         inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX sessions_token_hash_uidx ON sessions (token_hash);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
-- 过期 session 的批量清理靠它走索引扫描
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE spaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL,
  name        text NOT NULL,
  description text,
  visibility  text NOT NULL DEFAULT 'private'
              CHECK (visibility IN ('private', 'internal', 'public')),
  owner_id    uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX spaces_key_uidx ON spaces (key);

CREATE TABLE space_members (
  space_id   uuid NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, user_id)
);
CREATE INDEX space_members_user_id_idx ON space_members (user_id);

-- 邀请链接。位置不是随手放的：PG 要求外键引用的表先存在，
-- invitations.space_id 指向 spaces，所以必须排在 spaces 之后。
CREATE TABLE invitations (
  -- 只存哈希，不存明文：库被整个读走也换不出一条能用的链接
  token_hash   text PRIMARY KEY,
  username     text NOT NULL,
  display_name text NOT NULL,
  is_admin     boolean NOT NULL DEFAULT false,
  -- 可选：邀请时直接落进某个空间并带上角色，省掉「加完人再加空间」两步走
  space_id     uuid REFERENCES spaces (id) ON DELETE CASCADE,
  space_role   text CHECK (space_role IN ('owner', 'admin', 'editor', 'viewer')),
  created_by   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  used_by      uuid REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- 两个字段必须成对：给了空间却没角色，落库时无从下手
  CHECK ((space_id IS NULL) = (space_role IS NULL))
);
CREATE INDEX invitations_created_by_idx ON invitations (created_by);

-- 正文不在这里，只留一个指向当前版本的指针。
-- 反面做法是 documents 存当前正文、revisions 存历史，两份真相会漂移，
-- 结果是「你看到的和同事看到的不一样」——团队场景下灾难级且极难复现。
-- 代价是每次读要多一次 join，PG btree 下是微秒级，这个交换划算。
CREATE TABLE documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id            uuid NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
  parent_id           uuid REFERENCES documents (id) ON DELETE CASCADE,
  slug                text NOT NULL,
  current_revision_id uuid,
  status              text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'published', 'archived')),
  created_by          uuid NOT NULL REFERENCES users (id),
  updated_by          uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);
CREATE INDEX documents_space_id_idx ON documents (space_id);
CREATE INDEX documents_parent_id_idx ON documents (parent_id);

-- 同一父节点下 slug 唯一。两个反直觉但必须的点：
-- ⚠️ COALESCE：SQL 的 UNIQUE 把 NULL 视为互不相同，
--    直接建 (space_id, parent_id, slug) 会让根目录下的同名 slug 全部放行。
-- ⚠️ WHERE deleted_at IS NULL：否则软删除后重建同名文档会撞唯一约束。
CREATE UNIQUE INDEX documents_slug_uidx ON documents
  (space_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), slug)
  WHERE deleted_at IS NULL;

-- 全量快照，不是 diff 链：回滚只需改 documents.current_revision_id 指针，O(1)。
-- diff 链回滚要重放，收益却只是省几 KB 磁盘，等真出现 MB 级文档再优化。
-- title 在这里冗余一份快照，原因见 002_search.sql（生成列不能跨表引用）。
CREATE TABLE revisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  version_no  integer NOT NULL CHECK (version_no > 0),
  title       text NOT NULL,
  content     text NOT NULL DEFAULT '',
  author_id   uuid NOT NULL REFERENCES users (id),
  change_note text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX revisions_document_version_uidx ON revisions (document_id, version_no);
CREATE INDEX revisions_document_recent_idx ON revisions (document_id, version_no DESC);

-- documents 与 revisions 互为外键，构成循环依赖。插入顺序必须是：
--   1) INSERT documents（current_revision_id 留 NULL）
--   2) INSERT revisions
--   3) UPDATE documents SET current_revision_id = ...
-- 三步在同一事务内完成，见 src/domain/versioning.rs。
ALTER TABLE documents
  ADD CONSTRAINT documents_current_revision_fk
  FOREIGN KEY (current_revision_id) REFERENCES revisions (id);

-- 文档级权限覆盖。语义是「继承 + 提升」，不是全量枚举：
-- 默认继承 space 角色，只有这里显式出现的用户才被额外提升。
-- 想给某人降权请改 space_members.role，不要指望这张表——它只升不降。
-- （30 人 × 每篇文档全量枚举会让这张表爆炸且无法维护。）
CREATE TABLE document_acl (
  document_id uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  permission  text NOT NULL CHECK (permission IN ('read', 'write', 'admin')),
  granted_by  uuid REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, user_id)
);
CREATE INDEX document_acl_user_id_idx ON document_acl (user_id);

-- 编辑软锁。document_id 作主键，天然保证一篇文档同一时刻只有一把锁。
-- 靠 expires_at + 心跳续租兜底，用户直接关标签页也不会把文档锁死。
CREATE TABLE document_locks (
  document_id  uuid PRIMARY KEY REFERENCES documents (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  acquired_at  timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX document_locks_expires_at_idx ON document_locks (expires_at);

CREATE TABLE tags (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
  name     text NOT NULL,
  color    text
);
CREATE UNIQUE INDEX tags_space_name_uidx ON tags (space_id, name);

CREATE TABLE document_tags (
  document_id uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  tag_id      uuid NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, tag_id)
);
CREATE INDEX document_tags_tag_id_idx ON document_tags (tag_id);

-- 双链。target_id 允许为 NULL，表示悬空链接（目标文档还没建），
-- 此时靠 target_title 匹配，目标建好后再回填 target_id。
-- 有这张表才能算出孤儿文档（无人链入）与枢纽文档（被链最多）——
-- 这是知识库质量的度量，不是花架子。
CREATE TABLE links (
  source_id    uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  target_id    uuid REFERENCES documents (id) ON DELETE SET NULL,
  target_title text NOT NULL,
  kind         text NOT NULL DEFAULT 'ref' CHECK (kind IN ('ref', 'embed')),
  PRIMARY KEY (source_id, target_title)
);
CREATE INDEX links_target_id_idx ON links (target_id);
