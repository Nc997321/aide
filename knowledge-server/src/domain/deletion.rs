//! 文档软删。
//!
//! 只把 `documents.deleted_at` 置位，**绝不** `DELETE` 行：`revisions`、`assets`、
//! `document_locks` 都是 `ON DELETE CASCADE`，硬删会连全部版本历史与附件一起抹掉，
//! 不可逆。所有读路径都带 `deleted_at IS NULL`，所以置位就等于「从所有界面消失」。
//!
//! 权限判定不在这里：`domain::permission` 是权限的唯一产地，本模块只管「删哪些行」。
//!
//! **已知边界（并发建子文档）**：`create` 与「删父文档」重叠时，可能留下一个挂在已删
//! 父节点下的活文档——建文档的权限检查读的是它自己语句的快照，父节点在那之后才被删，
//! 插入照样提交（外键取父行的 `FOR KEY SHARE`，与删除 UPDATE 的 `FOR NO KEY UPDATE`
//! 不冲突）。窗口是两个请求重叠的那几毫秒，后果是一个仍可见、被侧栏按顶层缩进的孤儿。
//! 要封死得在 `create` 那侧对父行加锁并复检 `deleted_at`（改的是另一个模块的行为）；
//! 目前没有移动/重挂接口，先记为已知边界。

use sqlx::PgConnection;
use uuid::Uuid;

use crate::error::AppResult;

/// 软删 `document_id` 及其**整棵子树**，返回被删的文档 id（含根，顺序不保证）。
///
/// 级联是刻意的：只删自己会让子文档变成孤儿——列表里还在、父却没了，侧栏缩进
/// 退化成顶层，而用户完全看不出发生了什么。
pub async fn soft_delete_subtree(
    conn: &mut PgConnection,
    document_id: Uuid,
) -> AppResult<Vec<Uuid>> {
    // 递归 CTE 一趟走完，再拿结果去 UPDATE。两个细节：
    // ⚠️ 递归项也要带 `deleted_at IS NULL`：否则一棵「父已删、子未删」的历史残局会把
    //    子树的边界算错。
    // ⚠️ `UNION` 而不是 `UNION ALL`：parent_id 是用户数据，成环（a→b→a）时 UNION ALL
    //    会无限递归。树里每个 id 本来就只可能出现一次，去重不改变树的语义，环则原地停下
    //    （TS 侧 docTree.subtreeSize 的 `seen` 挡的是同一件事）。
    let rows: Vec<(Uuid,)> = sqlx::query_as(
        r#"WITH RECURSIVE subtree AS (
               SELECT id FROM documents WHERE id = $1 AND deleted_at IS NULL
               UNION
               SELECT d.id
                 FROM documents d
                 JOIN subtree s ON d.parent_id = s.id
                WHERE d.deleted_at IS NULL
           )
           UPDATE documents
              SET deleted_at = now(), updated_at = now()
            WHERE id IN (SELECT id FROM subtree)
           RETURNING id"#,
    )
    .bind(document_id)
    .fetch_all(&mut *conn)
    .await?;

    let deleted: Vec<Uuid> = rows.into_iter().map(|(id,)| id).collect();

    // 编辑锁一并清掉：锁只是「有人正在编辑」的短暂状态，文档都没了，锁行就成了烂在
    // 库里的孤儿（取不到锁，所以不阻塞谁，纯粹是脏）。空集合直接跳过——没必要为此
    // 发一趟 SQL。
    if !deleted.is_empty() {
        sqlx::query("DELETE FROM document_locks WHERE document_id = ANY($1)")
            .bind(&deleted)
            .execute(&mut *conn)
            .await?;
    }

    Ok(deleted)
}
