//! LSP 查询结果的线上 DTO（前端 / sidecar 共用的形状）。
//!
//! 历史上住在 codegraph-core 里（codegraph 已于 2026-10-01 移除，tag `codegraph-final`）。

use serde::{Deserialize, Serialize};

/// What kind of symbol this is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SymbolKind {
    Function,
    Method,
    Class,
    Field,
    Interface,
    Enum,
    Variable,
}

/// Source confidence tier. Wire format of `QueryResult.confidence`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Confidence {
    /// Extracted by tree-sitter AST parsing — high confidence.
    Structure,
    /// Retrieved via vector similarity — lower confidence, should be labelled "to verify".
    Semantic,
}

/// A single symbol definition found in source code.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolDef {
    pub name: String,
    pub kind: SymbolKind,
    /// Project-relative path, forward slashes.
    pub file: String,
    /// 1-based line number.
    pub line: usize,
    /// 1-based column (byte offset in line).
    pub column: usize,
    /// Containing class name for methods / fields; None for top-level symbols.
    pub parent: Option<String>,
    /// 1-based end line of the symbol's full span (inclusive). Lets the agent
    /// size Read precisely and lets find_symbol slice the full source instead
    /// of guessing a `limit`. `#[serde(default)]` so old index files (and old
    /// qdrant payloads) load with end_line = 0 → callers fall back to span-less
    /// behavior. Extractor fills this from `Node::end_position().row + 1`.
    #[serde(default)]
    pub end_line: usize,
}

/// Result returned to the frontend for a goto-definition query.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub symbol: SymbolDef,
    pub confidence: Confidence,
    /// Relevance score (only meaningful for Semantic results; 0.0–1.0 range).
    pub score: Option<f32>,
    /// The indexed code snippet (populated from the shard payload on semantic
    /// hits; None for structure-layer results). `#[serde(default)]` keeps old
    /// payloads / frontend types backward compatible.
    #[serde(default)]
    pub snippet: Option<String>,
}
