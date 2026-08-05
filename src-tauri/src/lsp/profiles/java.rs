//! Java：jdtls（Eclipse JDT Language Server）。
//! - 默认即 stdio（不认 `--stdio`，Aide 不注入）
//! - 需要 `-data <eclipse workspace>`（manager 按 workspace 哈希准备，不污染用户工作区）
//! - 元数据重定向：jdtls 1.54+ 内置 filesystem provider，读 JVM 系统属性
//!   `java.import.generatesMetadataFilesAtProjectRoot=false` 时把 .project/.classpath/.settings
//!   重定向到 -data 的 metadata 区域（项目根零污染）——经 `--jvm-arg` 注入，实测验证
//! - 握手 30s：jdtls 首次启动（OSGi 框架 + 索引）10-30s 常见，5s 必挂

use crate::lsp::registry::ServerProfile;
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

/// jdtls 元数据重定向系统属性（jdtls 1.54+ filesystem provider 读取）。
pub const METADATA_REDIRECT_ARG: &str =
    "--jvm-arg=-Djava.import.generatesMetadataFilesAtProjectRoot=false";

pub struct JavaProfile;

impl ServerProfile for JavaProfile {
    /// jdtls 的 -data（Eclipse workspace）：放项目 .aide/jdtls-workspace，
    /// 元数据重定向目标随项目走（ALWAYS_IGNORE_DIRS 已覆盖 .aide，文件树隐藏）。
    fn data_dir_name(&self) -> Option<&'static str> {
        Some("jdtls-workspace")
    }

    fn launch_args(&self, data_dir: Option<&Path>) -> Vec<String> {
        match data_dir {
            Some(d) => vec![
                "-data".to_string(),
                d.to_string_lossy().into_owned(),
                METADATA_REDIRECT_ARG.to_string(),
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

    fn init_options(&self, _exclude_globs: &[String]) -> Value {
        serde_json::json!({})
    }

    fn handshake_timeout(&self) -> Duration {
        Duration::from_secs(30)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lsp::registry::ServerSource;

    fn data() -> &'static Path {
        Path::new("C:/cache/jdtls-ws")
    }

    #[test]
    fn launch_args_has_data_and_redirect() {
        let args = JavaProfile.launch_args(Some(data()));
        assert_eq!(
            args,
            vec![
                "-data",
                "C:/cache/jdtls-ws",
                "--jvm-arg=-Djava.import.generatesMetadataFilesAtProjectRoot=false"
            ]
        );
        assert!(!args.contains(&"--stdio".to_string()), "jdtls 不认 --stdio");
        // data_dir 缺失（理论路径）：退化无参数
        assert_eq!(JavaProfile.launch_args(None), Vec::<String>::new());
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
        assert_eq!(args.iter().filter(|a| a.starts_with("--jvm-arg=")).count(), 1);
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
        let src = ServerSource::Which { binary: "jdtls".into() };
        let (prog, args) = crate::lsp::registry::to_command(
            crate::lsp::detector::LanguageId::Java,
            &src,
            Some(data()),
        );
        assert_eq!(prog, "jdtls");
        assert!(args.contains(&"-data".to_string()));
        assert!(args.iter().any(|a| a.starts_with("--jvm-arg=")));
    }
}
