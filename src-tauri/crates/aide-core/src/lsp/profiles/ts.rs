//! TypeScript / JavaScript：typescript-language-server。捆绑 + PATH 发现。
//!
//! 三条**初始化策略**：
//! - **自动类型安装恒关**（`disableAutomaticTypingAcquisition`）：见 `init_options` 里的注释
//!   ——Aide 不许在用户工作区里跑包管理器；
//! - **tsdk**（按工作区）：TLS 只在工作区根及其祖先里找 typescript，工程在子目录里时它
//!   看不见 → 由 `ts_sdk` 解析好、用 `initializationOptions.tsserver.path` 递进去；
//! - **Vue**（按工作区）：工作区有 `.vue` 且 `@vue/typescript-plugin` 可达时，把 Vue 支持
//!   挂进这个**已有的** TS 服务器（不新增进程）——见 `crate::lsp::vue_plugin`。

use crate::lsp::profiles::ts_sdk;
use crate::lsp::registry::{InitOptionsCtx, ServerProfile};
use serde_json::{json, Value};
use std::path::Path;

pub struct TsProfile;

impl ServerProfile for TsProfile {
    fn bundled(&self) -> Option<(&'static str, &'static str)> {
        Some(("typescript", "typescript-language-server"))
    }

    /// 工作区的初始化选项：
    /// - `tsserver.path` = 解析到的 tsdk（见 `ts_sdk` 抬头：TLS 不往子目录看）
    /// - Vue 插件（有 `.vue` 且插件可达时）——两个开关缺一不可：
    ///
    ///   `plugins`：让 tsserver 载入 Vue 插件。此后 `.vue` 文件进项目，**`.ts` 的引用
    ///   查询才看得见 `.vue` 里的用法**（实测：`applyTheme` 的 references 从 count=1
    ///   变成 count=7，与 grep 真值逐条吻合）。
    ///   `tsserver.useSyntaxServer: "never"`：**最容易漏的一条**。TLS 默认把请求分流给
    ///   syntax server，而 **syntax server 不加载插件** ⇒ 请求全被那个没有 Vue 能力的
    ///   实例接走，表现得跟没装插件一模一样。而日志里 `Loading global plugin …`
    ///   **照样打**（semantic 实例确实加载了），所以「插件没加载」这个方向会把人带偏。
    ///   代价：单文件操作也走 semantic 实例（更慢）——**所以只在真要 Vue 时才付**。
    ///
    /// 探不到插件、或工作区没有 `.vue` → 不挂插件项（与从前**逐字相同**）：
    /// 绝大多数工作区不碰 Vue，不能为它付出任何代价。
    fn init_options(&self, ctx: &InitOptionsCtx) -> Value {
        let workspace = Path::new(ctx.workspace);
        let mut opts = serde_json::Map::new();
        // **策略，恒开、不由工作区条件决定**：不许在用户工作区里跑包管理器。
        // tsserver 默认会自动安装缺失的 `@types/*`（写 package.json + node_modules），
        // TLS 默认替它打开。实测代价（2026-09-29）：一次被打断的会话把用户
        // `frontend/` 的顶层依赖挪进了 `node_modules/.ignored/`（vite/vue/typescript…），
        // 前端直接跑不起来——而用户既没批准、也不可见（`window/logMessage` 只进日志）。
        // 需要哪些 `@types` 由用户自己装；我们只做如实降级（类型提示少一些），
        // 不替用户改仓库。
        opts.insert(
            "disableAutomaticTypingAcquisition".to_string(),
            Value::Bool(true),
        );
        // 远程工作区（WSL / SSH）：SDK 与 Vue 插件的探测都是**桌面文件系统**上的遍历——
        // 全局候选指向桌面的 npm 目录（在目标机上不存在），工作区候选要经 9P / 根本摸不到。
        // 交给 TLS 在目标机上自己找 SDK（工作区根的 node_modules / 它自带的）；Vue 插件 v1 不挂。
        if crate::lsp::remote::is_remote(ctx.workspace) {
            return Value::Object(opts);
        }
        let mut tsserver = serde_json::Map::new();
        if let Some(sdk) = ts_sdk::sdk_entry_path(workspace) {
            tsserver.insert("path".to_string(), Value::String(sdk));
        }
        if let Some(plugins) = vue_plugins(ctx.workspace) {
            opts.insert("plugins".to_string(), plugins);
            tsserver.insert(
                "useSyntaxServer".to_string(),
                Value::String("never".to_string()),
            );
        }
        if !tsserver.is_empty() {
            opts.insert("tsserver".to_string(), Value::Object(tsserver));
        }
        Value::Object(opts)
    }
}

/// Vue 插件声明（插件目录 + 工作区有 `.vue` 两个条件都成立时才有值）。
fn vue_plugins(workspace: &str) -> Option<Value> {
    let plugin = crate::lsp::vue_plugin::find(workspace)?;
    if !crate::lsp::vue_plugin::has_vue_files(workspace) {
        return None;
    }
    Some(json!([{
        "name": crate::lsp::vue_plugin::PLUGIN_NAME,
        "location": plugin.to_string_lossy(),
        "languages": ["vue"],
    }]))
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

    /// **Vue 的默认路径不许变**：没插件（或没 .vue）时不挂插件、也不付
    /// `useSyntaxServer:"never"` 的代价——绝大多数工作区是纯 TS/JS。
    /// （`tsserver.path`（tsdk 注入）与本条无关、随环境出现，故这里只断言 Vue 相关键。）
    #[test]
    fn vue_stays_inert_without_plugin_or_vue_files() {
        let ws = tmp("inert");
        let opts = TsProfile.init_options(&ctx(ws.to_str().unwrap()));
        assert!(opts.get("plugins").is_none(), "{opts}");
        assert!(opts["tsserver"].get("useSyntaxServer").is_none(), "{opts}");

        // 有插件、但工作区没有 .vue → 仍然不挂
        let plugin = ws.join("node_modules").join("@vue/typescript-plugin");
        fs::create_dir_all(&plugin).unwrap();
        fs::write(plugin.join("package.json"), "{}").unwrap();
        let opts = TsProfile.init_options(&ctx(ws.to_str().unwrap()));
        assert!(opts.get("plugins").is_none(), "有插件但没 .vue → 仍不启用：{opts}");
        assert!(opts["tsserver"].get("useSyntaxServer").is_none(), "{opts}");
    }

    /// **恒开的策略**：自动类型安装必须关掉（它会在用户工作区里跑包管理器装 `@types/*`）。
    /// 三种形状都必须在——尤其「没有 tsdk、没有 Vue」那条最简路径，别让它掉回默认。
    #[test]
    fn typing_acquisition_is_always_disabled() {
        let plain = tmp("typing-plain");
        let opts = TsProfile.init_options(&ctx(plain.to_str().unwrap()));
        assert_eq!(opts["disableAutomaticTypingAcquisition"], json!(true), "{opts}");

        let vue = tmp("typing-vue");
        let plugin = vue.join("node_modules").join("@vue/typescript-plugin");
        fs::create_dir_all(&plugin).unwrap();
        fs::write(plugin.join("package.json"), "{}").unwrap();
        fs::create_dir_all(vue.join("src")).unwrap();
        fs::write(vue.join("src/App.vue"), "<template/>").unwrap();
        let opts = TsProfile.init_options(&ctx(vue.to_str().unwrap()));
        assert_eq!(opts["disableAutomaticTypingAcquisition"], json!(true), "{opts}");
        assert_eq!(opts["tsserver"]["useSyntaxServer"], "never", "{opts}");

        // 第三种形状：有 tsdk（子项目里那份）
        let sdk_ws = tmp("typing-tsdk");
        let sdk = sdk_ws.join("frontend").join("node_modules").join("typescript");
        fs::create_dir_all(sdk.join("lib")).unwrap();
        fs::write(sdk.join("lib/tsserver.js"), "// stub").unwrap();
        fs::write(sdk.join("package.json"), r#"{"version":"5.9.3"}"#).unwrap();
        let opts = TsProfile.init_options(&ctx(sdk_ws.to_str().unwrap()));
        assert_eq!(opts["disableAutomaticTypingAcquisition"], json!(true), "{opts}");
        assert!(opts["tsserver"]["path"].is_string(), "顺带确认 tsdk 注入了：{opts}");
    }

    /// 子项目里的 tsdk 要注进 `tsserver.path`——TLS 只在工作区根及其祖先里找 typescript，
    /// 「后端仓库 + frontend/ 前端」（agri-ai-agent）因此起不来（见 ts_sdk 抬头）。
    #[test]
    fn injects_tsdk_path_from_subproject() {
        let ws = tmp("tsdk");
        let sdk = ws.join("frontend").join("node_modules").join("typescript");
        fs::create_dir_all(sdk.join("lib")).unwrap();
        fs::write(sdk.join("lib/tsserver.js"), "// stub").unwrap();
        fs::write(sdk.join("package.json"), r#"{"version":"5.9.3"}"#).unwrap();

        let opts = TsProfile.init_options(&ctx(ws.to_str().unwrap()));
        let injected = opts["tsserver"]["path"].as_str().unwrap_or_default();
        assert!(
            injected.replace('\\', "/").ends_with("frontend/node_modules/typescript/lib/tsserver.js"),
            "该指向子项目那份 SDK：{opts}"
        );
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
