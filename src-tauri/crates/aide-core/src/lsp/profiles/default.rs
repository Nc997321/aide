//! 默认档案：未单独建 profile 的语言（Vue/Kotlin/Python/Dart/C#/Ruby/PHP/Elixir 等）。
//! 行为 = trait 全默认：不捆绑、PATH 发现（server 名见 LanguageId::server_binary）、
//! 标准 `--stdio`、5s 握手、无 data_dir。

use crate::lsp::registry::ServerProfile;

pub struct DefaultProfile;

impl ServerProfile for DefaultProfile {}
