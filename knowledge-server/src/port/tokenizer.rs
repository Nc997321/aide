//! 分词端口。
//!
//! 抽象它的理由：中文分词直接决定检索质量，而这块**迟早要换**。
//! 现在 jieba-rs 够用，但一旦出现「搜不准」需要换算法（基于模型的分词、
//! 或者换成数据库侧分词），改动应当只落在 `adapter::tokenizer` 下的一个文件。
//!
//! 抽象成本接近零（一个方法 + 一个自带默认实现的方法），收益是切换面收敛。

/// 分词器端口。
pub trait Tokenizer: Send + Sync {
    /// 后端标识，进日志与诊断
    fn id(&self) -> &'static str;

    /// 把文本切成词序列。
    fn cut(&self, text: &str) -> Vec<String>;

    /// 分词后拼成空格分隔的串，直接喂给 PG 的 `to_tsvector('simple', …)`。
    ///
    /// 数据库侧用 `simple` 配置而不是中文分词扩展：
    /// `simple` 会按空格切分并转小写，正好吃「上游已经分好词」的输入。
    /// 这样中文分词能力完全在应用层，不受 PG 扩展版本与安装限制——
    /// 也就省掉了在数据库上编译安装 zhparser 这一步。
    ///
    /// 默认实现基于 `cut()`，实现者一般无需重写。
    fn tokenize(&self, text: &str) -> String {
        self.cut(text).join(" ")
    }
}
