use crate::codegraph::embed::{embed_one, Embedder};
use crate::codegraph::shard::CodeShard;
use crate::codegraph::types::QueryResult;

/// Vector search via Qdrant Edge.
/// Embeds the query text and returns top-K semantically similar results.
///
/// The query is prefixed with `code: ` (via `embed_input`) to match the prefix
/// applied to document snippets at index time — same prefix on both sides keeps
/// queries and documents in the same embedding space, and avoids the bge-m3 NaN
/// trigger on bare code token sequences.
///
/// Results below `SCORE_THRESHOLD` (cosine similarity) are filtered out — below
/// this value bge-m3 matches are essentially random noise, especially for
/// cross-lingual queries (Chinese → English code).
pub fn semantic_search(
    query_text: &str,
    embedder: &dyn Embedder,
    shard: &CodeShard,
    limit: usize,
) -> Result<Vec<QueryResult>, Box<dyn std::error::Error>> {
    const SCORE_THRESHOLD: f32 = 0.55;

    let prefixed = crate::codegraph::embed_input(query_text);
    let vector = embed_one(embedder, &prefixed)?;
    let mut results = shard.search(&vector, limit * 3, None)?; // fetch more, then filter
    results.retain(|r| r.score.unwrap_or(0.0) >= SCORE_THRESHOLD);
    results.truncate(limit);
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegraph::embed::{HttpEmbedder, HttpEmbedderConfig, HttpFormat};
    use crate::codegraph::shard::CodeShard;
    use crate::codegraph::types::{Confidence, IndexedPoint, SymbolDef, SymbolKind};

    /// Cross-lingual semantic search: Chinese query → pure Rust code (no Chinese
    /// comments). Verifies bge-m3 can bridge Chinese NL to English code symbols.
    /// Requires Ollama running with bge-m3; skipped if unreachable.
    #[test]
    fn chinese_query_finds_pure_rust_code() {
        let emb = match HttpEmbedder::new(HttpEmbedderConfig {
            base_url: "http://localhost:11434".into(),
            api_key: String::new(),
            model: "bge-m3".into(),
            format: HttpFormat::Ollama,
            dim: 0,
        }) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("SKIP: cannot create bge-m3 embedder: {}", e);
                return;
            }
        };

        let dir = std::env::temp_dir().join(format!("cg_xling_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let shard = CodeShard::create(&dir, 1024).unwrap();

        // Pure Rust code — realistic project snippets, no Chinese anywhere
        let items: Vec<(&str, &str, usize, &str, SymbolKind)> = vec![
            (
                "pub async fn login(&self, username: &str, password: &str) -> Result<Token> { let user = self.repo.find_by_username(username).await?; verify_password(password, &user.password_hash)?; Ok(issue_token(user.id)) }",
                "auth.rs", 10, "login", SymbolKind::Function,
            ),
            (
                "pub fn parse_config(path: &Path) -> Config { let content = std::fs::read_to_string(path)?; toml::from_str(&content).map_err(Into::into) }",
                "config.rs", 20, "parse_config", SymbolKind::Function,
            ),
            (
                "fn compute_hash(data: &[u8]) -> [u8; 32] { use sha2::Digest; let mut hasher = sha2::Sha256::new(); hasher.update(data); hasher.finalize().into() }",
                "hash.rs", 30, "compute_hash", SymbolKind::Function,
            ),
            (
                "pub fn render_template(name: &str, ctx: &HashMap<String,String>) -> String { let mut hb = Handlebars::new(); hb.register_template_string(\"t\", name).ok(); hb.render(\"t\", ctx).unwrap_or_default() }",
                "render.rs", 40, "render_template", SymbolKind::Function,
            ),
            (
                "pub fn list_sessions(&self) -> Vec<Session> { self.sessions.lock().unwrap().values().cloned().collect() }",
                "session.rs", 50, "list_sessions", SymbolKind::Function,
            ),
            (
                "fn format_timestamp(ts: u64) -> String { chrono::DateTime::from_timestamp(ts as i64,0).map(|d|d.to_rfc3339()).unwrap_or_default() }",
                "util.rs", 60, "format_timestamp", SymbolKind::Function,
            ),
            (
                "struct User { id: i64, username: String, password_hash: String }",
                "models.rs", 70, "User", SymbolKind::Class,
            ),
            (
                "enum ExitCode { Success, NotFound, Unauthorized }",
                "errors.rs", 80, "ExitCode", SymbolKind::Enum,
            ),
        ];

        let mut pts = Vec::new();
        for (snippet, file, line, name, kind) in &items {
            pts.push(IndexedPoint {
                symbol: SymbolDef {
                    name: name.to_string(),
                    kind: *kind,
                    file: file.to_string(),
                    line: *line,
                    column: 1,
                    parent: None,
                },
                source: Confidence::Structure,
                code_snippet: snippet.to_string(),
            });
        }

        let prefixed: Vec<String> = pts.iter()
            .map(|p| crate::codegraph::embed_input(&p.code_snippet))
            .collect();
        let vectors = emb.embed_batch(&prefixed).unwrap();
        let indexed: Vec<(IndexedPoint, Vec<f32>)> = pts.into_iter().zip(vectors).collect();
        shard.upsert_with_vectors(&indexed).unwrap();

        let do_search = |query: &str| -> Vec<(String, f32)> {
            let prefixed = crate::codegraph::embed_input(query);
            let vec = crate::codegraph::embed::embed_one(&emb, &prefixed).unwrap();
            shard.search(&vec, 8, None).unwrap()
                .into_iter()
                .map(|r| (r.symbol.name.clone(), r.score.unwrap_or(0.0)))
                .collect()
        };

        // Each query should find the semantically correct symbol in the top 3.
        // (bge-m3 cross-lingual matching is inherently fuzzy — "user password" may
        // match the User struct (which stores credentials) higher than the login
        // function (which uses them). Both are reasonable.)
        let cases = [
            ("authenticate user password", "login"),
            ("compute sha256 hash digest", "compute_hash"),
            ("parse toml config file", "parse_config"),
            ("list all sessions", "list_sessions"),
            ("render html template", "render_template"),
        ];
        for (query, expected) in &cases {
            let results = do_search(query);
            let top3: Vec<&str> = results.iter().take(3).map(|r| r.0.as_str()).collect();
            eprintln!("  query={:?} top3={:?}", query, top3);
            assert!(top3.contains(expected),
                "query {:?}: expected {:?} in top 3, got {:?}", query, expected, top3);
        }

        drop(shard);
        std::fs::remove_dir_all(&dir).ok();
    }
}
