//! 领域类型。
//!
//! ⚠️ 数据库里的枚举列是 `text` + CHECK 约束，**不是 PG 原生 enum**。
//! 所以 Rust 侧先用 String 承接，再由 `TryFrom<&str>` 解析成领域枚举——
//! 这样不依赖 sqlx 对自定义枚举的映射行为，少一层魔法，也方便将来加值。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Owner,
    Admin,
    Editor,
    Viewer,
}

impl Role {
    /// 写回 `space_members.role` 时用。
    ///
    /// ⚠️ 骨架阶段唯一没接到调用方的成员：文档级 ACL 授权接口还没做，
    /// 目前角色只在建空间时由 SQL 字面量写入。等那个接口落地就用得上。
    #[allow(dead_code)]
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Owner => "owner",
            Role::Admin => "admin",
            Role::Editor => "editor",
            Role::Viewer => "viewer",
        }
    }

    /// space 角色换算成文档级基础权限
    pub fn base_permission(self) -> Permission {
        match self {
            Role::Owner | Role::Admin => Permission::Admin,
            Role::Editor => Permission::Write,
            Role::Viewer => Permission::Read,
        }
    }
}

impl TryFrom<&str> for Role {
    type Error = ();
    fn try_from(s: &str) -> Result<Self, ()> {
        match s {
            "owner" => Ok(Role::Owner),
            "admin" => Ok(Role::Admin),
            "editor" => Ok(Role::Editor),
            "viewer" => Ok(Role::Viewer),
            _ => Err(()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    Read,
    Write,
    Admin,
}

impl Permission {
    /// 取更强的那个。Option 的 None 代表「无权限」。
    pub fn stronger(a: Option<Self>, b: Option<Self>) -> Option<Self> {
        match (a, b) {
            (Some(x), Some(y)) => Some(if x >= y { x } else { y }),
            (Some(x), None) => Some(x),
            (None, Some(y)) => Some(y),
            (None, None) => None,
        }
    }

    pub fn at_least(self, required: Permission) -> bool {
        self >= required
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Visibility {
    Private,
    Internal,
    Public,
}

impl TryFrom<&str> for Visibility {
    type Error = ();
    fn try_from(s: &str) -> Result<Self, ()> {
        match s {
            "private" => Ok(Visibility::Private),
            "internal" => Ok(Visibility::Internal),
            "public" => Ok(Visibility::Public),
            _ => Err(()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentStatus {
    Draft,
    Published,
    Archived,
}

impl DocumentStatus {
    /// ⚠️ 骨架阶段未接线：文档状态目前只有一个默认值 draft，
    /// 读写接口都还没暴露 status。等发布/归档流程落地后用得上。
    #[allow(dead_code)]
    pub fn as_str(self) -> &'static str {
        match self {
            DocumentStatus::Draft => "draft",
            DocumentStatus::Published => "published",
            DocumentStatus::Archived => "archived",
        }
    }
}

impl TryFrom<&str> for DocumentStatus {
    type Error = ();
    fn try_from(s: &str) -> Result<Self, ()> {
        match s {
            "draft" => Ok(DocumentStatus::Draft),
            "published" => Ok(DocumentStatus::Published),
            "archived" => Ok(DocumentStatus::Archived),
            _ => Err(()),
        }
    }
}

/// 登录态用户。中间件解析出它，处理器直接用。
#[derive(Debug, Clone)]
pub struct CurrentUser {
    pub id: Uuid,
    pub username: String,
    /// 邀请制下没人填邮箱，所以可空
    pub email: Option<String>,
    pub display_name: String,
    /// 能不能建空间、能不能邀请人。与「在某个空间里是什么角色」无关
    pub is_admin: bool,
}

/// 检索结果一条
///
/// ⚠️ 所有跨 HTTP 边界的 DTO 一律 `camelCase`，对齐 aide 既有惯例
/// （`packages/aide-sdk/src/api/memoryObservatory.ts:3`：「与 Rust serde camelCase 镜像」）。
/// 唯一的例外是 Role / Visibility 这类枚举**值**——它们直接落库、与 SQL CHECK
/// 约束的字面量一致，保持 snake_case，靠枚举自己的 `rename_all` 显式钉住。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub document_id: Uuid,
    pub space_id: Uuid,
    pub title: String,
    pub version_no: i32,
    pub rank: f32,
    pub snippet: String,
}

/// 版本历史一条（不含正文，列表页不需要）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionSummary {
    pub id: Uuid,
    pub version_no: i32,
    pub title: String,
    pub author_id: Uuid,
    /// 作者昵称。单独带出来是因为前端要显示"这版是张三改的"，
    /// 否则客户端得为每一行再查一次 users 表。
    pub author_name: Option<String>,
    pub change_note: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// 节点类型。`doc` 有正文与版本历史，`folder` 是纯容器。
///
/// ⚠️ 「文件夹没有 current_revision_id、文档必须有」这条不变量**不是数据库约束**，
/// 原因见 migrations/006_documents_tree.sql 的注释（CHECK 不支持 DEFERRABLE，而
/// documents/revisions 的循环外键要求三步写入）。它由 domain/versioning.rs 维持。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentKind {
    Doc,
    Folder,
}

impl DocumentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DocumentKind::Doc => "doc",
            DocumentKind::Folder => "folder",
        }
    }

    pub fn is_folder(self) -> bool {
        matches!(self, DocumentKind::Folder)
    }
}

impl TryFrom<&str> for DocumentKind {
    type Error = ();
    fn try_from(s: &str) -> Result<Self, ()> {
        match s {
            "doc" => Ok(DocumentKind::Doc),
            "folder" => Ok(DocumentKind::Folder),
            _ => Err(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::DocumentKind;

    #[test]
    fn document_kind_round_trips() {
        for k in [DocumentKind::Doc, DocumentKind::Folder] {
            assert_eq!(DocumentKind::try_from(k.as_str()), Ok(k));
        }
    }

    #[test]
    fn unknown_kind_is_rejected() {
        assert!(DocumentKind::try_from("chapter").is_err());
        assert!(DocumentKind::try_from("").is_err());
    }

    #[test]
    fn only_folder_is_folder() {
        assert!(DocumentKind::Folder.is_folder());
        assert!(!DocumentKind::Doc.is_folder());
    }
}
