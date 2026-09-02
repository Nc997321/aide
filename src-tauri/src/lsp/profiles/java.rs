//! Java：jdtls（Eclipse JDT Language Server）。
//! - 默认即 stdio（不认 `--stdio`，Aide 不注入）
//! - 需要 `-data <eclipse workspace>`（manager 按 workspace 哈希准备，不污染用户工作区）
//! - 元数据重定向：jdtls 1.54+ 内置 filesystem provider，读 JVM 系统属性
//!   `java.import.generatesMetadataFilesAtProjectRoot=false` 时把 .project/.classpath/.settings
//!   重定向到 -data 的 metadata 区域（项目根零污染）——经 `--jvm-arg` 注入，实测验证
//! - 握手 30s：jdtls 首次启动（OSGi 框架 + 索引）10-30s 常见，5s 必挂

use crate::lsp::registry::{LaunchCtx, ServerProfile, ServerSource};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// jdtls 元数据重定向系统属性（jdtls 1.54+ filesystem provider 读取）。
pub const METADATA_REDIRECT_ARG: &str =
    "--jvm-arg=-Djava.import.generatesMetadataFilesAtProjectRoot=false";

/// 堆参数（对齐 vscode-java 默认 -Xmx2G）。jdtls 默认堆偏小，大项目索引/解析
/// 期间 GC 抖动 → 跳转/补全响应慢——跳转体验的核心成本项。仅内置来源（Which）
/// 注入；Explicit 用户自配不掺和（同 lombok 原则）。
pub const HEAP_ARG: &str = "--jvm-arg=-Xmx2G";

/// Java settings（initializationOptions.settings 与 workspace/configuration 应答同源）。
/// 关键项：
/// - downloadSources（maven/eclipse 双通道）：跳进依赖库直接读源码 jar，而非
///   fernflower 现场反编译 class——跳转进库符号从秒级降到毫秒级，审阅体验核心。
/// - codeLens 双关（references/implementations）：审阅场景无 gutter 需求，关掉省请求。
/// - validateAllOpenBuffersOnChanges=false：避免 jdtls 每次编辑全量重校验打开的
///   buffer（大项目卡顿来源）。
fn java_settings() -> Value {
    serde_json::json!({
        "java": {
            "maven": {"downloadSources": true},
            "eclipse": {"downloadSources": true},
            "import": {
                "maven": {"enabled": true},
                "gradle": {"enabled": true}
            },
            "completion": {"enabled": true},
            "signatureHelp": {"enabled": true},
            "referencesCodeLens": {"enabled": false},
            "implementationsCodeLens": {"enabled": false},
            "edit": {"validateAllOpenBuffersOnChanges": false},
            "autobuild": {"enabled": true}
        }
    })
}

pub struct JavaProfile;

impl ServerProfile for JavaProfile {
    /// data 目录名（jdtls-workspace）。位置由下方 data_dir_path 覆写决定——jdtls 必须
    /// 在工作区外（Eclipse 拒绝项目包含自己的 data 目录，报 overlaps → 拒导项目 →
    /// 定义/补全全空，bug4 真因），不走默认的 <workspace>/.aide/。
    fn data_dir_name(&self) -> Option<&'static str> {
        Some("jdtls-workspace")
    }

    /// jdtls 特例覆写：data 目录放 app_data_dir/lsp/jdtls-workspace/<工作区id>（工作区外）。
    /// 工作区路径派生 id 隔离多工作区；元数据重定向（generatesMetadataFilesAtProjectRoot=false）
    /// 把 .project/.classpath/.settings 重定向到 -data 的 metadata 区，项目根零污染。
    fn data_dir_path(&self, workspace: &str, config_dir: &Path) -> Option<PathBuf> {
        let name = self.data_dir_name()?;
        let ws_id: String = workspace
            .chars()
            .map(|c| {
                if c == ':' || c == '\\' || c == '/' {
                    '_'
                } else {
                    c
                }
            })
            .collect();
        Some(config_dir.join("lsp").join(name).join(ws_id))
    }

    fn launch_args(&self, data_dir: Option<&Path>) -> Vec<String> {
        match data_dir {
            Some(d) => vec![
                "-data".to_string(),
                d.to_string_lossy().into_owned(),
                METADATA_REDIRECT_ARG.to_string(),
                HEAP_ARG.to_string(),
            ],
            None => vec![],
        }
    }

    /// Explicit（用户自配 args）：补 -data 与重定向属性（缺则补，已配不重复）。
    fn supplement_explicit(&self, args: &mut Vec<String>, data_dir: Option<&Path>) {
        if let Some(dir) = data_dir {
            if !args.iter().any(|a| a == "-data") {
                args.push("-data".to_string());
                args.push(dir.to_string_lossy().into_owned());
            }
            if !args.iter().any(|a| a.starts_with("--jvm-arg")) {
                args.push(METADATA_REDIRECT_ARG.to_string());
            }
        }
    }

    /// Lombok：始终注入内置 lombok.jar（向 IDEA 看齐——jdtls 经 javaagent patch JDT
    /// AST，让编辑器看到 @Getter/@Data 生成的方法）。用户自配 jdtls（Explicit）时
    /// 不掺和；内置 jar 缺失（开发期/打包漏）则不注入，jdtls 仍可起。
    fn extra_args(&self, ctx: &LaunchCtx) -> Vec<String> {
        if matches!(ctx.src, ServerSource::Explicit { .. }) {
            return Vec::new();
        }
        build_lombok_args(resolve_lombok_jar(ctx).as_deref())
    }

    fn init_options(&self, _exclude_globs: &[String]) -> Value {
        serde_json::json!({
            // jdtls 扩展握手（vscode-java 同款）：classFileContentsSupport 允许
            // 打开 class 文件内容（跳进无源码的库时给反编译文本而非报错）。
            "extendedClientCapabilities": {
                "progressReportProvider": false,
                "classFileContentsSupport": true,
                "overrideDefaultAddAllExcludesToIgnore": true
            },
            // settings 内嵌一份（jdtls 初始化时读）；运行期靠 workspace/configuration
            // 拉取，应答走 settings()——两处同源 java_settings()。
            "settings": java_settings(),
        })
    }

    /// workspace/configuration 应答（与 init_options 内嵌 settings 同源）。
    fn settings(&self) -> Value {
        java_settings()
    }

    fn handshake_timeout(&self) -> Duration {
        Duration::from_secs(30)
    }

    /// jdtls 握手后还有项目导入 + 索引期，发 language/status 推进就绪阶段 → 消费。
    fn handles_status(&self) -> bool {
        true
    }

    /// 认 ServiceReady（jdtls 功能就绪）才置 ready=true。容错三种历史形式。
    fn is_ready_status(&self, status_type: &Value, message: &str) -> bool {
        is_service_ready(status_type, message)
    }
}

/// 解析内置 lombok jar：resource_dir/lsp/lombok.jar。失败（开发期未放/打包漏）
/// 返回 None → 不注入，jdtls 仍可起（只是没 lombok，@Getter 等仍报红）。
fn resolve_lombok_jar(ctx: &LaunchCtx) -> Option<PathBuf> {
    use tauri::Manager;
    let res_dir = ctx.app.path().resource_dir().ok()?;
    let jar = res_dir.join("lsp").join("lombok.jar");
    if jar.exists() {
        Some(jar)
    } else {
        None
    }
}

/// 判 jdtls `language/status` 通知是否代表功能就绪（项目导入 + 索引完成）。
/// 容错匹配三种历史形式，避免硬绑单一字面量：
/// - 新版 type="ServiceReady"（string）
/// - 旧版 type=3（int messageType，ServiceReady 的枚举值）
/// - message 含 "Service ready"（兜底，跨版本措辞）
/// 纯函数，单测核心。
pub fn is_service_ready(status_type: &Value, message: &str) -> bool {
    if status_type.as_str() == Some("ServiceReady") {
        return true;
    }
    if status_type.as_i64() == Some(3) {
        return true;
    }
    message.contains("Service ready")
}

/// 纯函数：按已解析的 lombok jar 构造注入参数（不碰 IO，单测核心）。
/// 两条 --jvm-arg 透传给 jdtls launcher，最终成 java 的 -javaagent / -Xbootclasspath/a。
/// 等号形式（--jvm-arg=...）让 launcher 把含空格的 jar 路径当单 argv 透传，不被 shell 拆分。
fn build_lombok_args(jar: Option<&Path>) -> Vec<String> {
    match jar {
        Some(j) => {
            // 剥 verbatim 前缀（dunce::simplified），否则 javaagent 路径解析可失败
            let p = dunce::simplified(j).to_string_lossy().into_owned();
            vec![
                format!("--jvm-arg=-javaagent:{p}"),
                format!("--jvm-arg=-Xbootclasspath/a:{p}"),
            ]
        }
        None => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn data() -> &'static Path {
        Path::new("C:/cache/jdtls-ws")
    }

    #[test]
    fn is_service_ready_matches_all_known_forms() {
        // 新版 string "ServiceReady"
        assert!(is_service_ready(&json!("ServiceReady"), ""));
        // 旧版 int 3（messageType）
        assert!(is_service_ready(&json!(3), ""));
        // message 兜底（message 含 "Service ready"）
        assert!(is_service_ready(&json!("Starting"), "Service ready now"));
        // 反例：非就绪阶段
        assert!(!is_service_ready(&json!("Starting"), "Importing project"));
        assert!(!is_service_ready(&json!("Started"), "Bundle started"));
        assert!(!is_service_ready(&json!("ProjectStatus"), "OK"));
        assert!(!is_service_ready(&json!(2), ""));
        assert!(!is_service_ready(&serde_json::Value::Null, ""));
    }

    #[test]
    fn build_lombok_args_none_is_empty() {
        assert!(build_lombok_args(None).is_empty());
    }

    #[test]
    fn build_lombok_args_injects_javaagent_and_bootclasspath() {
        let args = build_lombok_args(Some(Path::new("/opt/lombok.jar")));
        assert_eq!(args.len(), 2);
        assert!(
            args.iter()
                .any(|a| a == "--jvm-arg=-javaagent:/opt/lombok.jar"),
            "{args:?}"
        );
        assert!(
            args.iter()
                .any(|a| a == "--jvm-arg=-Xbootclasspath/a:/opt/lombok.jar"),
            "{args:?}"
        );
        // jdtls 不认 --stdio，lombok 注入也不应混入
        assert!(!args.iter().any(|a| a.contains("--stdio")));
    }

    #[test]
    fn build_lombok_args_uses_jvm_arg_equals_form() {
        // --jvm-arg= 等号形式：launcher 据此把含空格路径当单 argv 透传给 java
        let args = build_lombok_args(Some(Path::new("C:/Program Files/Aide/lombok.jar")));
        assert_eq!(args.len(), 2);
        assert!(args.iter().all(|a| a.starts_with("--jvm-arg=")), "{args:?}");
        assert!(args.iter().any(|a| a.contains("Program Files")), "{args:?}");
    }

    #[test]
    fn launch_args_has_data_redirect_and_heap() {
        let args = JavaProfile.launch_args(Some(data()));
        assert_eq!(
            args,
            vec![
                "-data",
                "C:/cache/jdtls-ws",
                "--jvm-arg=-Djava.import.generatesMetadataFilesAtProjectRoot=false",
                "--jvm-arg=-Xmx2G"
            ]
        );
        assert!(!args.contains(&"--stdio".to_string()), "jdtls 不认 --stdio");
        // data_dir 缺失（理论路径）：退化无参数
        assert_eq!(JavaProfile.launch_args(None), Vec::<String>::new());
    }

    #[test]
    fn init_options_feeds_settings_and_extended_capabilities() {
        let opts = JavaProfile.init_options(&[]);
        // 扩展握手：classFileContentsSupport 允许跳进无源码库时给 class 内容
        assert_eq!(
            opts["extendedClientCapabilities"]["classFileContentsSupport"],
            serde_json::json!(true)
        );
        // settings 内嵌：跳转进依赖库读源码而非反编译（跳转体验核心项）
        assert_eq!(
            opts["settings"]["java"]["maven"]["downloadSources"],
            serde_json::json!(true)
        );
        assert_eq!(
            opts["settings"]["java"]["eclipse"]["downloadSources"],
            serde_json::json!(true)
        );
        // codeLens 双关（审阅场景无 gutter 需求，省请求）
        assert_eq!(
            opts["settings"]["java"]["referencesCodeLens"]["enabled"],
            serde_json::json!(false)
        );
    }

    #[test]
    fn settings_matches_init_options_embedded_settings() {
        // 同源约束：workspace/configuration 应答与 initializationOptions.settings 一致，
        // 避免两处漂移（jdtls 运行期以 configuration 应答为准）。
        assert_eq!(JavaProfile.settings(), JavaProfile.init_options(&[])["settings"]);
    }

    #[test]
    fn supplement_explicit_fills_missing_only() {
        // 用户只填 program：补 -data + 重定向
        let mut args = vec![];
        JavaProfile.supplement_explicit(&mut args, Some(data()));
        assert_eq!(args.len(), 3, "{args:?}");
        assert!(args.contains(&"-data".to_string()));
        assert!(args.iter().any(|a| a.starts_with("--jvm-arg=")));

        // 用户已配 -data：不重复；重定向仍补
        let mut args = vec!["-data".to_string(), "D:/ws".to_string()];
        JavaProfile.supplement_explicit(&mut args, Some(data()));
        assert_eq!(args.iter().filter(|a| a.as_str() == "-data").count(), 1);
        assert!(args.iter().any(|a| a.starts_with("--jvm-arg=")));

        // 用户已自配 --jvm-arg：不重复
        let mut args = vec!["--jvm-arg=-Dlog.level=ALL".to_string()];
        JavaProfile.supplement_explicit(&mut args, Some(data()));
        assert_eq!(
            args.iter().filter(|a| a.starts_with("--jvm-arg=")).count(),
            1
        );
    }

    #[test]
    fn metadata_redirect_arg_constant_is_what_jdtls_reads() {
        // 与 jdtls filesystem provider 的 System.getProperty 键一致（实测验证过）
        assert_eq!(
            METADATA_REDIRECT_ARG,
            "--jvm-arg=-Djava.import.generatesMetadataFilesAtProjectRoot=false"
        );
    }

    #[test]
    fn works_with_which_source() {
        // 集成：Which source + to_command（走 profile launch_args）
        let src = ServerSource::Which {
            binary: "jdtls".into(),
        };
        let (prog, args) = crate::lsp::registry::to_command(
            crate::lsp::detector::LanguageId::Java,
            &src,
            Some(data()),
        );
        assert_eq!(prog, "jdtls");
        assert!(args.contains(&"-data".to_string()));
        assert!(args.iter().any(|a| a.starts_with("--jvm-arg=")));
    }

    #[test]
    fn jdtls_data_dir_outside_workspace_and_per_workspace() {
        // bug4 真因回归：jdtls -data 必须在工作区【外】，否则 Eclipse 拒导项目（overlaps）。
        let cfg = std::path::Path::new("/home/u/.aide");
        let p = JavaProfile
            .data_dir_path("C:\\proj\\alpha", cfg)
            .expect("Some");
        // 在 app_data_dir/lsp/jdtls-workspace/<ws_id> 下
        assert!(p.starts_with(cfg.join("lsp").join("jdtls-workspace")));
        // 不在工作区内（overlap 会让 jdtls 拒导项目）
        assert!(!p.starts_with(std::path::PathBuf::from("C:\\proj\\alpha")));
        // 不同工作区隔离（不串数据）
        assert_ne!(
            p,
            JavaProfile
                .data_dir_path("C:\\proj\\beta", cfg)
                .expect("Some")
        );
    }
}
