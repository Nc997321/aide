//! 摄取管道：把一个落盘文件变成一篇知识库文档。
//!
//! ⚠️ 这个文件是「端口/适配器分离」的验收点——**它只认识 `port::DocumentParser`**。
//! 文件里搜不到 docx-to-md、docx-lite、pdf-extract 任何一个库名，
//! 解析能力全部由注入进来的 `&dyn DocumentParser` 提供。
//!
//! 于是换解析库有两种粒度，都不用碰这里：
//!   1. 换单个格式的实现 → 改 `adapter/parser/` 下对应文件
//!   2. 换整套分派策略   → 改 `adapter/parser/registry.rs` 的 `with_defaults()`
//!
//! 分成同步 `parse_file` 与异步 `ingest_parsed` 两段，是因为：
//!   - 解析是 CPU 密集的同步操作（见 `port::DocumentParser` 注释），
//!     由调用方用 `spawn_blocking` 包一层比在这里假装 async 更诚实
//!   - 落库是 IO，必须 async
//! 两段分开后，调用方可以先阻塞解析、再异步落库，不会把 DB 连接按在 CPU 上等。

use std::path::{Path, PathBuf};

use sqlx::PgConnection;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
// 依赖的是**端口**而不是注册表本体：ingest 不知道有几个后端、
// 不知道注册表存在，更不知道背后是 docx-to-md 还是别的什么。
use crate::port::{ParserChain, Tokenizer};

use super::versioning;

#[derive(Debug, Clone)]
pub struct IngestInput {
    pub space_id: Uuid,
    pub parent_id: Option<Uuid>,
    /// 上传时的原始文件名。解析不出标题时用它兜底，也用于 slug 兜底。
    pub original_name: String,
    /// 已落盘到 `KB_STORAGE_DIR` 下的文件绝对路径
    pub stored_path: PathBuf,
    pub author_id: Uuid,
}

/// 解析阶段的产物。与 DB 无关，可以在 `spawn_blocking` 里算完再带回 async 上下文。
#[derive(Debug, Clone)]
pub struct ParsedFile {
    pub title: String,
    pub markdown: String,
    /// 实际生效的后端标识，落进日志/审计——「这篇文档为什么结构丢了」靠它解释
    pub backend: &'static str,
    /// 后端自报的降级信息，例如「含图片 12 张，已跳过」。
    /// 不吞掉：导入后内容少了要能说清为什么。
    pub warnings: Vec<String>,
}

/// 同步解析。调用方负责用 `tokio::task::spawn_blocking` 包一层。
pub fn parse_file(
    parsers: &dyn ParserChain,
    input: &IngestInput,
) -> AppResult<ParsedFile> {
    let path = &input.stored_path;
    if !path.exists() {
        return Err(AppError::BadRequest(format!(
            "文件不存在：{}",
            path.display()
        )));
    }

    let outcome = parsers.parse(path)?;

    // 标题三级兜底：文档内标题 → 文件名去扩展名 → 常量。
    // 宁可给个占位标题也不要留空：slug 与检索结果都要用它。
    let title = outcome
        .document
        .title
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| stem_of(&input.original_name))
        .trim()
        .to_string();
    let title = if title.is_empty() {
        "未命名文档".to_string()
    } else {
        title
    };

    Ok(ParsedFile {
        title,
        markdown: outcome.document.markdown,
        backend: outcome.backend,
        warnings: outcome.document.warnings,
    })
}

/// 落库：在 (space, parent) 下算出唯一 slug，然后建文档 + 首个版本。
/// 必须在事务里调用——建文档与首个 revision 是三步走，中断会留下悬空文档。
pub async fn ingest_parsed(
    conn: &mut PgConnection,
    tokenizer: &dyn Tokenizer,
    input: &IngestInput,
    parsed: ParsedFile,
) -> AppResult<IngestOutcome> {
    let slug = unique_slug(&mut *conn, input.space_id, input.parent_id, &parsed.title).await?;

    let (document_id, revision_id) = versioning::create_document(
        &mut *conn,
        tokenizer,
        versioning::CreateInput {
            space_id: input.space_id,
            parent_id: input.parent_id,
            slug,
            title: parsed.title.clone(),
            content: parsed.markdown,
            author_id: input.author_id,
        },
    )
    .await?;

    Ok(IngestOutcome {
        document_id,
        revision_id,
        title: parsed.title,
        backend: parsed.backend,
        warnings: parsed.warnings,
    })
}

#[derive(Debug, Clone)]
pub struct IngestOutcome {
    pub document_id: Uuid,
    pub revision_id: Uuid,
    pub title: String,
    pub backend: &'static str,
    pub warnings: Vec<String>,
}

/// 同步解析 + 异步落库的便利封装。
///
/// 用于 CLI / 后台任务这类本身就不在 async runtime 关键路径上的调用方。
/// HTTP 处理器**不要**用它——请自己 `spawn_blocking` 调 `parse_file`，
/// 否则会把解析的 CPU 时间压到 tokio 的工作线程上。
///
/// ⚠️ 骨架阶段唯一没接到调用方的入口：批量导入脚本还没写。
/// 留着是因为 CLI 导入迟早要有，而它的正确用法（先阻塞解析、再异步落库）
/// 值得有个地方写下示范。
#[allow(dead_code)]
pub async fn ingest_file(
    conn: &mut PgConnection,
    parsers: &dyn ParserChain,
    tokenizer: &dyn Tokenizer,
    input: &IngestInput,
) -> AppResult<IngestOutcome> {
    let parsed = parse_file(parsers, input)?;
    ingest_parsed(&mut *conn, tokenizer, input, parsed).await
}

fn stem_of(name: &str) -> String {
    Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string()
}

/// 生成 URL 友好的 slug。
///
/// 刻意保留 CJK 表意文字：团队知识库大量中文标题，全音译或全丢弃都会让链接不可读，
/// 而 PG 与现代浏览器对 UTF-8 slug 都没问题。
///
/// 保留的是**表意文字本身**，不是「所有非 ASCII」——中文标点（`。，、：`）
/// 会被当分隔符处理，否则 slug 里出现句号既难看又容易在复制粘贴时出错。
fn is_kept(ch: char) -> bool {
    ch.is_ascii_alphanumeric()
        || matches!(ch,
            '\u{3400}'..='\u{4DBF}'   // CJK 扩展 A
            | '\u{4E00}'..='\u{9FFF}' // CJK 基本区
            | '\u{F900}'..='\u{FAFF}' // 兼容表意文字
        )
}

pub fn slugify(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    // 连续分隔符折叠成一个：标题里的 " —— " 不该变成 "a------b"
    let mut last_dash = false;

    for ch in input.trim().chars() {
        if ch == '-' || ch == '_' {
            if !last_dash && !out.is_empty() {
                out.push('-');
                last_dash = true;
            }
            continue;
        }

        if is_kept(ch) {
            out.push(if ch.is_ascii_uppercase() {
                ch.to_ascii_lowercase()
            } else {
                ch
            });
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
    }

    // 先折叠再裁剪：截断可能又留下一个尾巴上的 -
    let mut out = out.trim_matches('-').to_string();
    if out.chars().count() > 80 {
        out = out.chars().take(80).collect::<String>();
        out = out.trim_end_matches('-').to_string();
    }

    if out.is_empty() {
        // 全被过滤掉（纯符号、纯 emoji 之类的标题）
        format!("doc-{}", Uuid::new_v4().simple())
    } else {
        out
    }
}

/// 在同一 (space, parent) 下算出不冲突的 slug：重名则追加 -2 / -3。
///
/// 用循环重试而不是 `count(*) + 1`：后者在删掉中间项后会撞已有 slug，
/// 而循环每次都拿最新的冲突情况重新判断。
pub async fn unique_slug(
    conn: &mut PgConnection,
    space_id: Uuid,
    parent_id: Option<Uuid>,
    title: &str,
) -> AppResult<String> {
    let base = slugify(title);
    let mut candidate = base.clone();

    for n in 2..200 {
        let exists: Option<(Uuid,)> = sqlx::query_as(
            "SELECT id FROM documents
              WHERE space_id = $1
                AND COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid)
                  = COALESCE($2, '00000000-0000-0000-0000-000000000000'::uuid)
                AND slug = $3
                AND deleted_at IS NULL",
        )
        .bind(space_id)
        .bind(parent_id)
        .bind(&candidate)
        .fetch_optional(&mut *conn)
        .await?;

        if exists.is_none() {
            return Ok(candidate);
        }
        candidate = format!("{base}-{n}");
    }

    Err(AppError::Conflict(format!(
        "slug 冲突过多，无法为「{title}」生成唯一标识"
    )))
}

#[cfg(test)]
mod tests {
    use super::slugify;

    #[test]
    fn slugify_keeps_cjk_and_lowercases() {
        assert_eq!(slugify("Rust 所有权模型"), "rust-所有权模型");
        assert_eq!(slugify("  Hello, World!  "), "hello-world");
        assert_eq!(slugify("a---b"), "a-b");
        assert_eq!(slugify("foo_bar"), "foo-bar");
    }

    #[test]
    fn slugify_treats_cjk_punctuation_as_separator() {
        // 中文句号/顿号不该留在 slug 里
        assert_eq!(slugify("设计原则。三条"), "设计原则-三条");
        assert_eq!(slugify("A、B"), "a-b");
    }

    #[test]
    fn slugify_truncates_without_trailing_dash() {
        let long = "a ".repeat(100);
        let out = slugify(&long);
        assert_eq!(out.chars().count(), 79);
        assert!(!out.ends_with('-'));
    }

    #[test]
    fn slugify_falls_back_when_empty() {
        assert!(slugify("!!!").starts_with("doc-"));
        assert!(slugify("").starts_with("doc-"));
    }
}
