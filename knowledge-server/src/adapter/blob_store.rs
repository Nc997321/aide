//! 文件系统实现。根目录来自 `KB_STORAGE_DIR`（compose 里是具名卷 `kbdata`）。
//!
//! 键是**裸 uuid**：Word 内嵌图没有「原文件名」这个概念，
//! 带上原始文件名只会多一份客户端可控的输入要防。
//! （上传的原始 docx 临时文件另有一套命名，见 `api/ingest.rs` 的 `sanitize_file_name`。）

use std::path::PathBuf;

use crate::port::{BlobError, BlobStore};

pub struct FilesystemBlobStore {
    root: PathBuf,
}

impl FilesystemBlobStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// storage_key → 绝对路径。拒绝一切可能逃出 root 的键。
    fn resolve(&self, key: &str) -> Result<PathBuf, BlobError> {
        let bad = key.is_empty()
            || key.contains('/')
            || key.contains('\\')
            || key.contains("..")
            || key == ".";
        if bad {
            return Err(BlobError::InvalidKey(key.to_string()));
        }
        Ok(self.root.join(key))
    }
}

impl BlobStore for FilesystemBlobStore {
    fn put(&self, bytes: &[u8]) -> Result<String, BlobError> {
        std::fs::create_dir_all(&self.root)
            .map_err(|e| BlobError::Write(format!("创建存储目录失败：{e}")))?;

        let key = uuid::Uuid::new_v4().simple().to_string();
        let path = self.root.join(&key);
        std::fs::write(&path, bytes)
            .map_err(|e| BlobError::Write(format!("写入 {} 失败：{e}", path.display())))?;
        Ok(key)
    }

    fn get(&self, key: &str) -> Result<Vec<u8>, BlobError> {
        let path = self.resolve(key)?;
        std::fs::read(&path)
            .map_err(|e| BlobError::Read(format!("读取 {} 失败：{e}", path.display())))
    }

    fn delete(&self, key: &str) -> Result<(), BlobError> {
        let path = self.resolve(key)?;
        std::fs::remove_file(&path)
            .map_err(|e| BlobError::Delete(format!("删除 {} 失败：{e}", path.display())))
    }
}

#[cfg(test)]
mod tests {
    use super::FilesystemBlobStore;
    use crate::port::BlobStore;

    /// 不用 tempfile 依赖：uuid 子目录 + 用完自删。
    fn temp_root() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("kb-blob-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn put_then_get_roundtrip() {
        let root = temp_root();
        let store = FilesystemBlobStore::new(&root);

        let key = store.put(b"\x89PNG-fake-bytes").unwrap();
        assert!(!key.is_empty(), "键不能为空");
        assert_eq!(store.get(&key).unwrap(), b"\x89PNG-fake-bytes");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn put_generates_distinct_keys() {
        let root = temp_root();
        let store = FilesystemBlobStore::new(&root);

        let a = store.put(b"a").unwrap();
        let b = store.put(b"b").unwrap();
        assert_ne!(a, b, "同内容两次 put 必须是两个键：v1 不做去重");
        assert_eq!(store.get(&a).unwrap(), b"a");
        assert_eq!(store.get(&b).unwrap(), b"b");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn delete_removes_bytes() {
        let root = temp_root();
        let store = FilesystemBlobStore::new(&root);

        let key = store.put(b"x").unwrap();
        store.delete(&key).unwrap();
        assert!(store.get(&key).is_err(), "删除后 get 必须失败");

        std::fs::remove_dir_all(&root).ok();
    }

    /// 键是从数据库读回来的字符串，必须拒绝任何能逃出 root 的形态。
    #[test]
    fn rejects_path_traversal_keys() {
        let root = temp_root();
        let store = FilesystemBlobStore::new(&root);

        for bad in ["../evil", "a/b", "a\\b", "..", ""] {
            assert!(store.get(bad).is_err(), "应拒绝键 {bad:?}");
            assert!(store.delete(bad).is_err(), "应拒绝键 {bad:?}");
        }

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn creates_root_dir_on_demand() {
        let root = temp_root().join("nested").join("deeper");
        let store = FilesystemBlobStore::new(&root);

        let key = store.put(b"y").unwrap();
        assert_eq!(store.get(&key).unwrap(), b"y");

        std::fs::remove_dir_all(root.parent().unwrap().parent().unwrap()).ok();
    }
}
