//! 二进制存储端口。
//!
//! 领域层只认这里的 trait，不知道字节落在文件系统、对象存储还是别处。
//! 与 `DocumentParser` 同理：**保持同步**（文件 IO 密集），
//! 调用方需要异步时用 `tokio::task::spawn_blocking` 包一层。

/// 存储错误。只描述事实，不含任何第三方类型。
#[derive(Debug, thiserror::Error)]
pub enum BlobError {
    #[error("写入失败：{0}")]
    Write(String),

    #[error("读取失败：{0}")]
    Read(String),

    #[error("删除失败：{0}")]
    Delete(String),

    /// 键非法（空串、含路径分隔符、含 `..`）。
    ///
    /// 键虽然由本服务生成，但它是从数据库读回来的字符串 ——
    /// 这一层防的是「库里被写进脏值」，不是「用户可控的键」。
    #[error("非法的存储键：{0}")]
    InvalidKey(String),
}

pub trait BlobStore: Send + Sync {
    /// 写入字节并返回 storage_key。键的生成规则由实现决定。
    fn put(&self, bytes: &[u8]) -> Result<String, BlobError>;

    fn get(&self, key: &str) -> Result<Vec<u8>, BlobError>;

    fn delete(&self, key: &str) -> Result<(), BlobError>;
}
