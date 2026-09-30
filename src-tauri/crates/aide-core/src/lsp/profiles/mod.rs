//! 语言 server 启动档案（策略模式）：每个语言一个 profile，收敛该语言的全部特判——
//! server 名、捆绑、启动参数、初始化选项、握手超时、是否需要 data_dir。
//! 加新语言 = 加一个文件 + 下面注册表一行，不再散弹式改多处 match。

use crate::lsp::detector::LanguageId;
use crate::lsp::registry::ServerProfile;

mod default;
mod go;
mod java;
mod rust;
mod ts;
mod ts_sdk;

pub use default::DefaultProfile;
pub use go::GoProfile;
pub use java::JavaProfile;
pub use rust::RustProfile;
pub use ts::TsProfile;

/// 语言 → 启动档案。静态实例（零分配），新增语言在此登记。
pub fn profile(lang: LanguageId) -> &'static dyn ServerProfile {
    match lang {
        LanguageId::Java => &JavaProfile,
        LanguageId::Rust => &RustProfile,
        LanguageId::Go => &GoProfile,
        // .vue 也走这里：它的支持是挂进 TS 服务器的插件（见 ts.rs），不是独立 server
        LanguageId::TypeScript | LanguageId::JavaScript => &TsProfile,
        // 其余语言走通用默认（--stdio + 5s 握手，PATH 发现）
        _ => &DefaultProfile,
    }
}
