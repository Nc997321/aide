//! 跨子系统共享的"始终 prune"目录黑名单。
//!
//! 单一真源：codegraph indexer walk 与 lsp server exclude 都从这里取，
//! 避免两处硬编码漂移。背景见原 codegraph/indexer/walk.rs 注释——
//! `ignore` crate 的 standard_filters 只在有 .gitignore 时忽略 node_modules 等，
//! 无 .gitignore 项目会让 walk/index 钻进构建产物与依赖目录。

/// 始终 prune 的目录名（不依赖 .gitignore 是否存在）。
pub const ALWAYS_IGNORE_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "coverage",
    ".git",
    ".aide",
    ".next",
    ".nuxt",
    ".turbo",
    ".parcel-cache",
    ".svelte-kit",
    ".angular",
    ".cache",
    "__pycache__",
    ".venv",
    "venv",
    ".idea",
    ".vscode",
    ".settings",  // Eclipse/jdtls 项目元数据（.project/.classpath 的同族，防索引污染）
    ".elixir_ls", // elixir-ls 在项目内建的缓存（DETS 索引等）
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn always_ignore_dirs_contains_junk_dirs() {
        // 单一真源内容锁定：增删目录需显式改这里，并同步 codegraph/lsp 测试。
        assert!(ALWAYS_IGNORE_DIRS.contains(&"node_modules"));
        assert!(ALWAYS_IGNORE_DIRS.contains(&"target"));
        assert!(ALWAYS_IGNORE_DIRS.contains(&".git"));
        assert!(ALWAYS_IGNORE_DIRS.contains(&".aide"));
    }
}
