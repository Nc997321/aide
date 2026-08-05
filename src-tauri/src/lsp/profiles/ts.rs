//! TypeScript / JavaScript：typescript-language-server。捆绑 + PATH 发现。

use crate::lsp::registry::ServerProfile;

pub struct TsProfile;

impl ServerProfile for TsProfile {
    fn bundled(&self) -> Option<(&'static str, &'static str)> {
        Some(("typescript", "typescript-language-server"))
    }
}
