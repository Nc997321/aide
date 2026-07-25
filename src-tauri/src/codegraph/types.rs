use serde::{Deserialize, Serialize};

/// What kind of symbol this is. Determines tree-sitter node type mapping.
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

/// Source confidence tier — structure layer is ground truth, semantic is guess.
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
}

/// A directed call edge between two named symbols.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallEdge {
    pub caller: String,
    pub callee: String,
    pub file: String,
    pub line: usize,
}

/// A point stored in the Qdrant Edge shard — symbol + the text used to embed it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexedPoint {
    pub symbol: SymbolDef,
    pub source: Confidence,
    /// The exact text chunk that was embedded (method signature + body start, etc.)
    pub code_snippet: String,
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
