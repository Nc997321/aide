//! Query submodule: structure-layer (exact, cross-file SymbolTable lookup) and
//! semantic-layer (Qdrant vector search) helpers. The command layer in `mod.rs`
//! composes them: structure first under a read lock, semantic fallback second
//! after releasing the lock.

pub mod calls;
pub mod semantic;
pub mod structure;