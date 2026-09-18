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
use crate::types::DocumentKind;
// 依赖的是**端口**而不是注册表本体：ingest 不知道有几个后端、
// 不知道注册表存在，更不知道背后是 docx-to-md 还是别的什么。
use crate::port::{
    placeholder, BlobStore, ParsedAsset, ParserChain, Tokenizer, PLACEHOLDER_CLOSE, PLACEHOLDER_OPEN,
};

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
    /// 含解析期占位符 `{{asset:i}}`；`prepare_assets` 会把它换成 `asset://<uuid>`。
    pub markdown: String,
    /// 实际生效的后端标识，落进日志/审计——「这篇文档为什么结构丢了」靠它解释
    pub backend: &'static str,
    /// 后端自报的降级信息，例如「3 个文本框未提取」。
    /// 不吞掉：导入后内容少了要能说清为什么。
    pub warnings: Vec<String>,
    /// 附件原始字节。由解析器产出（见 `port::DocumentParser` 的占位符契约）。
    pub assets: Vec<ParsedAsset>,
}

/// 已落盘、待入库的附件。
#[derive(Debug, Clone)]
pub struct PendingAsset {
    /// **在 Rust 侧生成**，不依赖数据库默认值 ——
    /// 这样替换占位符时就知道最终引用形态，blob 的写也能完全在事务之外完成。
    pub id: Uuid,
    pub storage_key: String,
    pub mime: String,
    pub size_bytes: i64,
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
        assets: outcome.document.assets,
    })
}

/// 落库：在 (space, parent) 下算出唯一 slug，然后建文档 + 首个版本。
/// 必须在事务里调用——建文档与首个 revision 是三步走，中断会留下悬空文档。
pub async fn ingest_parsed(
    conn: &mut PgConnection,
    tokenizer: &dyn Tokenizer,
    input: &IngestInput,
    mut parsed: ParsedFile,
    assets: &[PendingAsset],
) -> AppResult<IngestOutcome> {
    // 最后一道防线：任何残留的解析期占位符都不许进正文
    // （见 strip_leftover_placeholders —— 它进正文比丢一张图更糟）
    let (clean, removed) = strip_leftover_placeholders(&parsed.markdown);
    if removed > 0 {
        tracing::warn!(removed, "正文里残留了解析期占位符，已移除");
        parsed.warnings.push(format!("{removed} 处图片引用无效，已移除"));
    }
    parsed.markdown = clean;

    let slug = unique_slug(&mut *conn, input.space_id, input.parent_id, &parsed.title).await?;

    // 导入产出的永远是文档，不可能是文件夹（文件夹没有正文可导入）
    let (document_id, revision_id, _) = versioning::create_node(
        &mut *conn,
        tokenizer,
        versioning::CreateInput {
            space_id: input.space_id,
            parent_id: input.parent_id,
            kind: DocumentKind::Doc,
            slug,
            title: parsed.title.clone(),
            content: parsed.markdown,
            author_id: input.author_id,
        },
    )
    .await?;

    insert_assets(&mut *conn, document_id, input.author_id, assets).await?;

    Ok(IngestOutcome {
        document_id,
        revision_id,
        title: parsed.title,
        backend: parsed.backend,
        warnings: parsed.warnings,
    })
}

/// 附件行入库。
///
/// id 由调用方（`prepare_assets`）生成 —— 与 blob 的写入次序解耦，
/// 因此这里不需要读数据库默认值，正文里的引用也能在事务外就拼好。
async fn insert_assets(
    conn: &mut PgConnection,
    document_id: Uuid,
    author_id: Uuid,
    assets: &[PendingAsset],
) -> AppResult<()> {
    for a in assets {
        sqlx::query(
            r#"INSERT INTO assets (id, document_id, mime, size_bytes, storage_key, created_by)
               VALUES ($1, $2, $3, $4, $5, $6)"#,
        )
        .bind(a.id)
        .bind(document_id)
        .bind(&a.mime)
        .bind(a.size_bytes)
        .bind(&a.storage_key)
        .bind(author_id)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
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
    // 这个入口没有 BlobStore，因此不落附件（正文里的占位符由 ingest_parsed 的防线清掉）。
    // 真要支持附件，得把 blobs 也传进来 —— 等批量导入脚本真写的时候一起做。
    ingest_parsed(&mut *conn, tokenizer, input, parsed, &[]).await
}

/// 把解析期占位符换成持久化引用，并把附件字节写进 `BlobStore`。
///
/// ⚠️ **在数据库事务之外调用。** blob 的 IO 夹在事务里会长时间占住连接与行锁，
/// 而且事务回滚**不会撤销**已经落盘的字节 —— 反而制造出「库里没有、盘上有」的孤儿。
/// 先写 blob 再开事务，最坏情况只留下可回收的孤儿 blob，不会留下不一致的库状态。
pub fn prepare_assets(blobs: &dyn BlobStore, parsed: &mut ParsedFile) -> Vec<PendingAsset> {
    let mut pending = Vec::new();
    let mut markdown = std::mem::take(&mut parsed.markdown);
    let assets = std::mem::take(&mut parsed.assets);

    for (idx, asset) in assets.into_iter().enumerate() {
        let token = placeholder(idx);
        let size_bytes = asset.bytes.len() as i64;

        match blobs.put(&asset.bytes) {
            Ok(storage_key) => {
                let id = Uuid::new_v4();
                markdown = markdown.replace(&token, &format!("asset://{id}"));
                pending.push(PendingAsset {
                    id,
                    storage_key,
                    mime: asset.mime,
                    size_bytes,
                });
            }
            Err(e) => {
                // 降级不失败：把该占位符整个移除（不留悬空引用），并如实上报。
                // 与 `ParseOutcome.warnings` 的既有语义一致。
                markdown = markdown.replace(&token, "");
                parsed.warnings.push(format!("1 张图片上传失败，已省略：{e}"));
            }
        }
    }

    parsed.markdown = markdown;
    pending
}

/// 最后一道防线：移除残留的解析期占位符。
///
/// 正常路径下替换环节已把它们全部换掉，走到这里还剩下说明有 bug（例如某个 adapter
/// 自己拼了占位符而没产出对应的 asset）。**不能让它进正文** ——
/// 残留的 `{{asset:0}}` 会以纯文本形态永久留在文档里，比丢掉一张图更糟。
///
/// 返回 (清理后的正文, 移除个数)。
pub fn strip_leftover_placeholders(markdown: &str) -> (String, usize) {
    let mut out = String::with_capacity(markdown.len());
    let mut removed = 0usize;
    let mut rest = markdown;

    while let Some(start) = rest.find(PLACEHOLDER_OPEN) {
        out.push_str(&rest[..start]);
        let after = &rest[start + PLACEHOLDER_OPEN.len()..];
        match after.find(PLACEHOLDER_CLOSE) {
            Some(end) => {
                rest = &after[end + PLACEHOLDER_CLOSE.len()..];
                removed += 1;
            }
            None => {
                // 只有前缀没有闭合：整段丢掉，别再往回找
                rest = "";
                removed += 1;
            }
        }
    }

    out.push_str(rest);
    (out, removed)
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

    // ── 附件：占位符替换与残留防线 ──────────────────────────────────────────

    use super::*;
    use crate::port::{BlobError, BlobStore, ParsedAsset};

    /// 内存实现：让 domain 的单测完全不碰文件系统（这正是抽出 BlobStore 的收益）。
    struct MemBlobs {
        written: std::sync::Mutex<std::collections::HashMap<String, Vec<u8>>>,
        /// 第 N 次 put 必失败（从 0 起）。None = 全部成功。
        fail_at: Option<usize>,
        calls: std::sync::atomic::AtomicUsize,
    }

    impl MemBlobs {
        fn new() -> Self {
            Self {
                written: Default::default(),
                fail_at: None,
                calls: Default::default(),
            }
        }
        fn failing_at(n: usize) -> Self {
            Self {
                fail_at: Some(n),
                ..Self::new()
            }
        }
    }

    impl BlobStore for MemBlobs {
        fn put(&self, bytes: &[u8]) -> Result<String, BlobError> {
            let n = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.fail_at == Some(n) {
                return Err(BlobError::Write("注入的失败".into()));
            }
            let key = format!("key{n}");
            self.written
                .lock()
                .unwrap()
                .insert(key.clone(), bytes.to_vec());
            Ok(key)
        }
        fn get(&self, key: &str) -> Result<Vec<u8>, BlobError> {
            self.written
                .lock()
                .unwrap()
                .get(key)
                .cloned()
                .ok_or_else(|| BlobError::Read("不存在".into()))
        }
        fn delete(&self, key: &str) -> Result<(), BlobError> {
            self.written.lock().unwrap().remove(key);
            Ok(())
        }
    }

    fn parsed_with(markdown: &str, assets: Vec<ParsedAsset>) -> ParsedFile {
        ParsedFile {
            title: "T".into(),
            markdown: markdown.to_string(),
            backend: "test",
            warnings: Vec::new(),
            assets,
        }
    }

    fn png(n: u8) -> ParsedAsset {
        ParsedAsset {
            mime: "image/png".into(),
            bytes: vec![n; 4],
        }
    }

    #[test]
    fn replaces_placeholders_with_asset_urls() {
        let blobs = MemBlobs::new();
        // 头、图片之间、尾三段正文都要活下来 —— 所以输入刻意两端都有字
        let mut parsed = parsed_with(
            "前 ![a]({{asset:0}}) 中 ![b]({{asset:1}}) 尾",
            vec![png(1), png(2)],
        );

        let pending = prepare_assets(&blobs, &mut parsed);

        assert_eq!(pending.len(), 2);
        assert!(parsed
            .markdown
            .contains(&format!("asset://{}", pending[0].id)));
        assert!(parsed
            .markdown
            .contains(&format!("asset://{}", pending[1].id)));
        assert!(!parsed.markdown.contains("{{asset:"), "不得残留占位符");
        assert!(parsed.markdown.starts_with("前 "), "首部正文必须保留");
        assert!(parsed.markdown.contains(" 中 "), "图片之间的正文必须保留");
        assert!(parsed.markdown.ends_with(" 尾"), "尾部正文必须保留");
    }

    /// 顺序不能错位：第 2 张图换成的必须是第 2 个 uuid。
    #[test]
    fn maps_indices_to_the_right_assets() {
        let blobs = MemBlobs::new();
        let mut parsed = parsed_with("![a]({{asset:0}})![b]({{asset:1}})", vec![png(1), png(2)]);

        let pending = prepare_assets(&blobs, &mut parsed);

        assert_eq!(blobs.get(&pending[0].storage_key).unwrap(), vec![1u8; 4]);
        assert_eq!(blobs.get(&pending[1].storage_key).unwrap(), vec![2u8; 4]);
        let first = parsed
            .markdown
            .find(&format!("asset://{}", pending[0].id))
            .unwrap();
        let second = parsed
            .markdown
            .find(&format!("asset://{}", pending[1].id))
            .unwrap();
        assert!(first < second, "第 0 张图必须先出现");
    }

    /// 单张失败不整体失败：移除该占位符 + 记 warning，其余照常。
    #[test]
    fn one_failed_upload_degrades_that_image_only() {
        let blobs = MemBlobs::failing_at(1);
        let mut parsed = parsed_with("![a]({{asset:0}})![b]({{asset:1}})", vec![png(1), png(2)]);

        let pending = prepare_assets(&blobs, &mut parsed);

        assert_eq!(pending.len(), 1, "只有 1 张成功");
        assert!(parsed
            .markdown
            .contains(&format!("asset://{}", pending[0].id)));
        assert!(
            !parsed.markdown.contains("{{asset:"),
            "失败的那张的占位符必须被移除"
        );
        assert_eq!(parsed.warnings.len(), 1);
        assert!(
            parsed.warnings[0].contains("1 张图片上传失败"),
            "实际：{}",
            parsed.warnings[0]
        );
    }

    /// 0 张图是正常路径，不是边界情况。
    #[test]
    fn no_assets_is_a_normal_path() {
        let blobs = MemBlobs::new();
        let mut parsed = parsed_with("没有图的文档", Vec::new());

        let pending = prepare_assets(&blobs, &mut parsed);

        assert!(pending.is_empty());
        assert_eq!(parsed.markdown, "没有图的文档", "无附件时正文必须逐字节不变");
        assert!(parsed.warnings.is_empty());
    }

    #[test]
    fn strips_leftover_placeholders() {
        let (out, n) = strip_leftover_placeholders("a {{asset:0}} b {{asset:7}} c");

        assert_eq!(n, 2);
        assert_eq!(out, "a  b  c");
        assert!(!out.contains("{{asset:"));
    }

    #[test]
    fn clean_text_is_untouched_by_the_guard() {
        let (out, n) = strip_leftover_placeholders("干净的正文 ![a](asset://abc)");

        assert_eq!(n, 0);
        assert_eq!(out, "干净的正文 ![a](asset://abc)");
    }

    /// 只有前缀没有闭合也要被吃掉，不能留在正文里。
    #[test]
    fn leftover_guard_handles_unclosed_prefix() {
        let (out, n) = strip_leftover_placeholders("a {{asset:0 b");

        assert_eq!(n, 1);
        assert!(!out.contains("{{asset:"));
    }

    /// 落库前的正文里既不能有解析期占位符，也不能有 `asset://0` 这种下标形态。
    #[test]
    fn persisted_markdown_never_contains_placeholder_forms() {
        let blobs = MemBlobs::new();
        let mut parsed = parsed_with("![a]({{asset:0}}) 尾", vec![png(1)]);
        let pending = prepare_assets(&blobs, &mut parsed);
        assert_eq!(pending.len(), 1);

        let (clean, removed) = strip_leftover_placeholders(&parsed.markdown);

        assert_eq!(removed, 0, "正常路径下防线不该有活干");
        assert!(!clean.contains("{{asset:"));

        // ⚠️ 这里**不能**写 `!clean.contains("asset://0")` ——
        //    uuid 恰好以 `0` 开头时（1/16 概率）`asset://0abc-…` 会包含该子串，
        //    变成偶发误报。改成取出引用内容做精确比对。
        let refs: Vec<&str> = clean
            .split("asset://")
            .skip(1)
            .map(|s| s.split(')').next().unwrap_or(""))
            .collect();
        assert_eq!(refs.len(), 1, "注入 1 张图就该只有 1 个引用");
        assert_eq!(
            refs[0],
            pending[0].id.to_string(),
            "引用必须是真实 uuid，不能是 `asset://0` 这种下标形态"
        );
    }
}
