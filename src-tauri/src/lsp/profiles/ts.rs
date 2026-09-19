//! TypeScript / JavaScript：typescript-language-server。捆绑 + PATH 发现。
//!
//! 另有一个**按工作区**的扩展：工作区有 `.vue` 且 `@vue/typescript-plugin` 可达时，
//! 把 Vue 支持挂进这个**已有的** TS 服务器（不新增进程）——见 `init_options` 与
//! `crate::lsp::vue_plugin`。

use crate::lsp::registry::{InitOptionsCtx, ServerProfile};
use serde_json::{json, Value};

pub struct TsProfile;

impl ServerProfile for TsProfile {
    fn bundled(&self) -> Option<(&'static str, &'static str)> {
        Some(("typescript", "typescript-language-server"))
    }

    /// 工作区有 `.vue` 且插件可达 → 把 Vue 支持挂进 TS 服务器。两个开关缺一不可：
    ///
    /// - `plugins`：让 tsserver 载入 Vue 插件。此后 `.vue` 文件进项目，**`.ts` 的引用
    ///   查询才看得见 `.vue` 里的用法**（实测：`applyTheme` 的 references 从 count=1
    ///   变成 count=7，与 grep 真值逐条吻合）。
    /// - `tsserver.useSyntaxServer: "never"`：**最容易漏的一条**。TLS 默认把请求分流给
    ///   syntax server，而 **syntax server 不加载插件** ⇒ 请求全被那个没有 Vue 能力的
    ///   实例接走，表现得跟没装插件一模一样。而日志里 `Loading global plugin …`
    ///   **照样打**（semantic 实例确实加载了），所以「插件没加载」这个方向会把人带偏。
    ///   代价：单文件操作也走 semantic 实例（更慢）——**所以只在真要 Vue 时才付**。
    ///
    /// 探不到插件、或工作区没有 `.vue` → 返回空对象，行为与从前**逐字相同**。这条很重要：
    /// 绝大多数工作区不碰 Vue，不能为它付出任何代价。
    fn init_options(&self, ctx: &InitOptionsCtx) -> Value {
        let Some(plugin) = crate::lsp::vue_plugin::find(ctx.workspace) else {
            return json!({});
        };
        if !crate::lsp::vue_plugin::has_vue_files(ctx.workspace) {
            return json!({});
        }
        json!({
            "plugins": [{
                "name": crate::lsp::vue_plugin::PLUGIN_NAME,
                "location": plugin.to_string_lossy(),
                "languages": ["vue"],
            }],
            "tsserver": { "useSyntaxServer": "never" },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("aide_ts_profile_{}_{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn ctx(workspace: &str) -> InitOptionsCtx<'_> {
        InitOptionsCtx { workspace, exclude_globs: &[] }
    }

    /// **默认路径不许变**：没插件（或没 .vue）时必须返回空对象——绝大多数工作区是
    /// 纯 TS/JS，不能为 Vue 付 `useSyntaxServer:"never"` 的代价。
    #[test]
    fn inert_without_plugin_or_vue_files() {
        let ws = tmp("inert");
        assert_eq!(TsProfile.init_options(&ctx(ws.to_str().unwrap())), json!({}));

        // 有插件、但工作区没有 .vue → 仍然空（不启用）
        let plugin = ws.join("node_modules").join("@vue/typescript-plugin");
        fs::create_dir_all(&plugin).unwrap();
        fs::write(plugin.join("package.json"), "{}").unwrap();
        assert_eq!(TsProfile.init_options(&ctx(ws.to_str().unwrap())), json!({}));
    }

    #[test]
    fn injects_plugin_and_disables_syntax_server_when_both_hold() {
        let ws = tmp("inject");
        let plugin = ws.join("node_modules").join("@vue/typescript-plugin");
        fs::create_dir_all(&plugin).unwrap();
        fs::write(plugin.join("package.json"), "{}").unwrap();
        let src = ws.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("App.vue"), "<template/>").unwrap();

        let opts = TsProfile.init_options(&ctx(ws.to_str().unwrap()));
        assert_eq!(opts["tsserver"]["useSyntaxServer"], "never");
        let entry = &opts["plugins"][0];
        assert_eq!(entry["name"], "@vue/typescript-plugin");
        assert_eq!(entry["languages"][0], "vue");
        assert_eq!(
            entry["location"].as_str().unwrap(),
            plugin.to_string_lossy().as_ref(),
            "location 必须是插件目录本身（tsserver 的 pluginProbeLocations）"
        );
    }
}
