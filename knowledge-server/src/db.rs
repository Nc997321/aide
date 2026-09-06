//! 数据库连接池。
//!
//! 池大小刻意压到 20，与给 PG 调的 `max_connections = 20` 对齐——
//! 这台机器上 PG 只是共存进程之一，不该放开抢内存。

use std::time::Duration;

use sqlx::postgres::{PgPool, PgPoolOptions};

use crate::config::Config;

pub async fn create_pool(config: &Config) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(20)
        .acquire_timeout(Duration::from_secs(5))
        .idle_timeout(Duration::from_secs(60))
        .connect(&config.db_url)
        .await
}

/// 应用迁移。幂等：已执行过的文件跳过。
///
/// 没有引入外部迁移工具——按文件名顺序执行 `migrations/*.sql` 就够了，
/// 少一个依赖，也少一套约定要记。
pub async fn migrate(pool: &PgPool) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query(
        r#"CREATE TABLE IF NOT EXISTS _migrations (
               name       text PRIMARY KEY,
               applied_at timestamptz NOT NULL DEFAULT now()
           )"#,
    )
    .execute(pool)
    .await?;

    let applied: Vec<(String,)> = sqlx::query_as("SELECT name FROM _migrations")
        .fetch_all(pool)
        .await?;
    let applied: Vec<String> = applied.into_iter().map(|(n,)| n).collect();

    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let mut entries: Vec<_> = std::fs::read_dir(&dir)
        .map_err(|e| sqlx::Error::Configuration(format!("读取 migrations 目录失败: {e}").into()))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("sql"))
        .collect();
    entries.sort();

    let mut ran = Vec::new();
    for path in entries {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();

        if applied.contains(&name) {
            continue;
        }

        let sql = std::fs::read_to_string(&path)
            .map_err(|e| sqlx::Error::Configuration(format!("读取 {name} 失败: {e}").into()))?;

        // 每个迁移文件一个事务：失败就整份回滚，不留半截 schema
        let mut tx = pool.begin().await?;
        //
        // 迁移 SQL 是整份文件的多语句，走 simple query protocol（raw_sql），
        // 而 sqlx 0.9 起 raw_sql 只接受 `&'static str` 或 `AssertSqlSafe` 包过的串。
        // 这里包一层是**经过审计的**：SQL 全部来自仓库内 migrations/ 目录，
        // 没有任何外部输入被拼进去，不存在注入面。
        // 注意别把用户可控的串也这样包——那等于把这个护栏整个废掉。
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql.as_str()))
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO _migrations (name) VALUES ($1)")
            .bind(&name)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;

        tracing::info!(migration = %name, "迁移已应用");
        ran.push(name);
    }

    Ok(ran)
}
