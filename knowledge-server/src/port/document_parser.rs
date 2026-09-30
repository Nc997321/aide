//! 文档解析端口。
//!
//! 摄取管道只依赖这里的 `DocumentParser`，不感知 docx-lite / docx-to-md / pdf-extract
//! 任何一个库的存在。换解析库 = 在 `crate::adapter::parser` 下换一个实现文件，
//! 上层（`domain::ingest`）与出口层一行不动。
//!
//! 之所以值得抽象：文档解析是本项目里**竞争实现最多、成熟度差异最大**的一块
//! （docx 一家就有 docx-to-md / docx-lite / office_oxide / rwml 四个候选，
//! 且 docx-to-md 目前才 0.1.0）。把这种不确定性关在 adapter 里，是它唯一该待的地方。

use std::path::Path;

/// 解析产出的附件（目前只有图片）。
///
/// 领域自己的类型，不泄漏任何第三方库类型 —— 这样换解析库时上层拿到的是同一个结构。
#[derive(Debug, Clone)]
pub struct ParsedAsset {
    pub mime: String,
    pub bytes: Vec<u8>,
}

/// 解析期占位符的前缀与后缀。
///
/// ⚠️ **必须与持久化引用 `asset://<uuid>` 用不同的记号。**
/// 解析期是「下标」且临时，持久化是「uuid」且永久。若两者共用一个前缀，
/// 一旦替换环节出 bug，残留的 `asset://0` 会被下游当成一个**合法的** asset id
/// 继续走 —— 静默指向不存在的资源，排查成本极高。
pub const PLACEHOLDER_OPEN: &str = "{{asset:";
pub const PLACEHOLDER_CLOSE: &str = "}}";

/// 由下标生成解析期占位符。adapter 与 domain **共用这一个函数**，
/// 语法只在这一处定义（谁都不许自己拼字符串）。
pub fn placeholder(idx: usize) -> String {
    format!("{PLACEHOLDER_OPEN}{idx}{PLACEHOLDER_CLOSE}")
}

/// 解析产物。本项目自己的类型，不泄漏任何第三方库的类型——
/// 这样无论底层换成哪个库，上层拿到的都是同一个结构。
#[derive(Debug, Clone)]
pub struct ParsedDocument {
    /// **落库那份内容**的类型，不是上传文件的类型：docx / pdf 传进来会被解析成
    /// markdown，所以它们的 `mime` 仍是 `text/markdown`；html 是文本形态，
    /// 原件原样存 `markdown` 字段（字段名是历史包袱，它就是「正文」）。
    ///
    /// 由服务端按扩展名决定，绝不采信客户端给的 `Content-Type`。
    pub mime: String,

    /// 统一转成 Markdown。知识库的一等存储格式就是 Markdown。
    /// 附件位置以解析期占位符 `{{asset:<下标>}}` 标记，见 [`placeholder`]。
    pub markdown: String,

    /// 从文档属性或首个标题推断出的标题，推断不出则为 None。
    pub title: Option<String>,

    /// 解析器主动报告的降级信息，例如「3 个文本框未提取」。
    /// 保留这些是为了让「导入后内容少了」能被解释清楚，而不是变成玄学。
    pub warnings: Vec<String>,

    /// 附件原始字节 + MIME。markdown 里的 `{{asset:<下标>}}` 按**下标**对应本数组。
    pub assets: Vec<ParsedAsset>,
}

/// 解析失败。只描述事实，不含第三方错误类型——否则又把实现细节漏上来了。
#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("解析 {path} 失败：{reason}")]
    Failed { path: String, reason: String },
}

/// 文档解析器端口。
///
/// ⚠️ 刻意设计成**同步**：解析是 CPU 密集操作，做成 async 只会徒增
/// `async-trait` 依赖和 `Box<dyn Future>` 堆分配，并不带来真正的并发。
/// 需要不阻塞请求线程时，由调用方用 `tokio::task::spawn_blocking` 包一层。
pub trait DocumentParser: Send + Sync {
    /// 后端标识，进日志与诊断输出
    fn id(&self) -> &'static str;

    /// 能处理的扩展名（小写、不含点）。注册表据此分派。
    ///
    /// 这与 aide 的 LSP 红线同构：公共层按扩展名分派，
    /// 不允许出现 `if is_docx()` 这类针对具体格式的分支。
    fn extensions(&self) -> &[&'static str];

    /// 解析落盘文件。
    ///
    /// 用 path 而不是 bytes：摄取流程里文件已经落到 `KB_STORAGE_DIR`，
    /// 且主流解析库基本都只接受路径。
    fn parse(&self, path: &Path) -> Result<ParsedDocument, ParseError>;
}

/// 解析产物 + 实际生效的后端标识。
/// 留着 backend 是为了排障：「这篇文档为什么结构丢了」——
/// 一看 backend 是 docx-lite 就知道它回落过。
#[derive(Debug)]
pub struct ParseOutcome {
    pub document: ParsedDocument,
    pub backend: &'static str,
}

/// 解析链端口：**按扩展名分派 + 失败回退**。
///
/// 与 `DocumentParser` 分开，是因为两者职责不同、变化频率也不同：
///   - `DocumentParser` 是「一个后端能不能解析一种格式」
///   - `ParserChain` 是「多个后端怎么组织」——注册顺序、回退、留痕
///
/// 上层（`domain::ingest`）只认 `ParserChain`，连「有几个后端」都不知道。
/// 于是换后端是改 adapter 里的一行，换分派策略是换一个 ParserChain 实现，
/// 两种情况都不用动领域层与 HTTP 层。
pub trait ParserChain: Send + Sync {
    /// 挑出能处理该扩展名的后端依次尝试，第一个成功的胜出。
    fn parse(&self, path: &Path) -> Result<ParseOutcome, ParseError>;

    /// 全链支持的扩展名（去重排序），供 `/api/ingest/formats` 返回。
    fn supported_extensions(&self) -> Vec<String>;

    /// 链上挂了哪些后端，**按尝试顺序**返回。
    /// 给 `/api/health` 用：排障时一眼能看出实际装配了什么、优先级如何。
    fn backend_ids(&self) -> Vec<&'static str>;
}

#[cfg(test)]
mod tests {
    use super::{placeholder, PLACEHOLDER_OPEN};

    /// 占位符语法是 adapter 与 domain 之间的契约，两端共用这一个函数 —— 钉住它。
    #[test]
    fn placeholder_format_is_stable() {
        assert_eq!(placeholder(0), "{{asset:0}}");
        assert_eq!(placeholder(12), "{{asset:12}}");
        assert!(placeholder(3).starts_with(PLACEHOLDER_OPEN));
    }
}
