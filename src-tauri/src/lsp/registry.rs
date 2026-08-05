use crate::commands::settings::{AppSettings, ServerOverride};
use crate::lsp::detector::LanguageId;
use std::path::Path;
use std::time::Duration;

// ── ServerProfile：语言 server 启动档案（策略模式） ──
//
// 每个语言一个 profile（见 profiles/），收敛该语言的全部特判：捆绑、启动参数、
// Explicit 补充、初始化选项、握手超时、是否需要 data_dir。registry 只保留通用骨架。
pub trait ServerProfile {
    /// 捆绑资源子目录 + 二进制名（None = 该语言不捆绑，靠 which / 用户覆盖）。
    fn bundled(&self) -> Option<(&'static str, &'static str)> {
        None
    }

    /// 需要的隔离数据目录名（放在 `<workspace>/.aide/<name>`，如 jdtls 的
    /// `-data` Eclipse workspace）。None = 不需要（默认）。
    fn data_dir_name(&self) -> Option<&'static str> {
        None
    }

    /// 语言特有启动参数（含标准 `--stdio`——除 jdtls 默认即 stdio 外都走 stdio）。
    fn launch_args(&self, _data_dir: Option<&Path>) -> Vec<String> {
        vec!["--stdio".to_string()]
    }

    /// Explicit（用户自配 program + args）时的缺省补充：缺 `--stdio` 补之。
    /// Java 覆写：不补 --stdio，补 -data 与元数据重定向属性（见 profiles/java.rs）。
    fn supplement_explicit(&self, args: &mut Vec<String>, _data_dir: Option<&Path>) {
        if !args.iter().any(|a| a == "--stdio") {
            args.push("--stdio".to_string());
        }
    }

    /// initialize 的 initializationOptions（按语言注入排除集等）。
    fn init_options(&self, _exclude_globs: &[String]) -> serde_json::Value {
        serde_json::json!({})
    }

    /// 握手判活超时（Java 例外 30s：jdtls 首次启动 OSGi + 索引 10-30s 常见）。
    fn handshake_timeout(&self) -> Duration {
        Duration::from_secs(5)
    }
}

/// 已解析的 server 启动来源。
#[derive(Debug, Clone)]
pub enum ServerSource {
    /// 随 tauri resources 捆绑：resource_dir/lsp/<subdir>/<binary>。
    Bundled { subdir: String, binary: String },
    /// PATH 上 `which` 发现的二进制（存完整路径——含 .bat/.cmd 扩展名，spawn 时判断包装）。
    Which { binary: String },
    /// 用户设置显式覆盖的 program + args。
    Explicit { program: String, args: Vec<String> },
}

/// 纯函数：按优先级选 source。无 IO，单测核心。
/// 优先级：用户覆盖 > 捆绑 > PATH 发现。三者皆 None → None（该语言无可用 server）。
pub fn pick_source(
    override_cfg: Option<&ServerOverride>,
    bundled: Option<ServerSource>,
    which: Option<ServerSource>,
) -> Option<ServerSource> {
    if let Some(o) = override_cfg {
        if !o.program.is_empty() {
            return Some(ServerSource::Explicit {
                program: o.program.clone(),
                args: o.args.clone(),
            });
        }
    }
    bundled.or(which)
}

/// 解析某语言的 server 启动来源。优先级：settings.lsp.servers[lang] > 捆绑(resource_dir) > which(binary)。
pub fn resolve(lang: LanguageId, settings: &AppSettings, app: &tauri::AppHandle) -> Option<ServerSource> {
    let override_cfg = settings.lsp.servers.get(lang.id_str());
    let bundled = bundled_source(lang, app);
    let which = which_source(lang);
    pick_source(override_cfg, bundled, which)
}

fn bundled_source(lang: LanguageId, app: &tauri::AppHandle) -> Option<ServerSource> {
    use tauri::Manager;
    let (subdir, binary) = crate::lsp::profiles::profile(lang).bundled()?;
    let binary = if cfg!(windows) { format!("{binary}.exe") } else { binary.to_string() };
    let res_dir = app.path().resource_dir().ok()?;
    let path = res_dir.join("lsp").join(subdir).join(&binary);
    if path.exists() {
        Some(ServerSource::Bundled { subdir: subdir.to_string(), binary })
    } else {
        None
    }
}

fn which_source(lang: LanguageId) -> Option<ServerSource> {
    let bin = lang.server_binary()?;
    // 存 which 解析出的完整路径（Windows 上含 .exe/.bat/.cmd 扩展名）——spawn 时
    // 需要扩展名判断 .bat/.cmd 必须 cmd /C 包装（CreateProcess 不能直接跑 bat）。
    let path = which::which(bin).ok()?;
    Some(ServerSource::Which { binary: path.to_string_lossy().into_owned() })
}

/// 转 (program, args)。program 是要 spawn 的可执行文件路径/名。
/// Bundled 的 program 是 dunce 剥前缀后的完整资源路径（调用方在 spawn 时剥，这里只给原路径，
/// 因为 resource_dir 在 resolve 时已是 verbatim；spawn 前由 manager 剥——见 to_spawn_command）。
/// 语言特有参数一律走 profile（launch_args / supplement_explicit）。
pub fn to_command(lang: LanguageId, src: &ServerSource, data_dir: Option<&Path>) -> (String, Vec<String>) {
    let p = crate::lsp::profiles::profile(lang);
    match src {
        ServerSource::Bundled { subdir, binary } => {
            (format!("lsp/{subdir}/{binary}"), p.launch_args(data_dir))
        }
        ServerSource::Which { binary } => (binary.clone(), p.launch_args(data_dir)),
        ServerSource::Explicit { program, args } => {
            let mut full = args.clone();
            p.supplement_explicit(&mut full, data_dir);
            (program.clone(), full)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::settings::{LspSettings, ServerOverride};
    use std::collections::HashMap;

    fn override_for(lang: &str, program: &str) -> AppSettings {
        let mut servers = HashMap::new();
        servers.insert(lang.to_string(), ServerOverride {
            program: program.to_string(),
            args: vec![],
        });
        AppSettings {
            lsp: LspSettings { servers },
            ..Default::default()
        }
    }

    fn empty_settings() -> AppSettings {
        AppSettings::default()
    }

    #[test]
    fn precedence_settings_over_bundled_over_which() {
        let settings = override_for("rust", "/my/custom/rust-analyzer");
        let bundled = Some(ServerSource::Bundled {
            subdir: "rust".into(), binary: "rust-analyzer".into(),
        });
        let which = Some(ServerSource::Which { binary: "rust-analyzer".into() });
        let picked = pick_source(settings.lsp.servers.get("rust"), bundled, which);
        match picked {
            Some(ServerSource::Explicit { program, .. }) => {
                assert_eq!(program, "/my/custom/rust-analyzer");
            }
            other => panic!("expected Explicit, got {other:?}"),
        }
    }

    #[test]
    fn bundled_missing_falls_to_which() {
        let settings = empty_settings();
        let which = Some(ServerSource::Which { binary: "gopls".into() });
        let picked = pick_source(settings.lsp.servers.get("go"), None, which);
        assert!(matches!(picked, Some(ServerSource::Which { .. })));
    }

    #[test]
    fn all_missing_returns_none() {
        let settings = empty_settings();
        let picked = pick_source(settings.lsp.servers.get("rust"), None, None);
        assert!(picked.is_none());
    }

    #[test]
    fn settings_args_passed_through() {
        let mut servers = HashMap::new();
        servers.insert("rust".to_string(), ServerOverride {
            program: "/x/rust-analyzer".into(),
            args: vec!["--log-file".into(), "/tmp/ra.log".into()],
        });
        let settings = AppSettings { lsp: LspSettings { servers }, ..Default::default() };
        let picked = pick_source(settings.lsp.servers.get("rust"), None, None);
        match picked {
            Some(ServerSource::Explicit { program, args }) => {
                assert_eq!(program, "/x/rust-analyzer");
                // pick_source 只负责选源，不注入任何参数（那是 to_command 的职责）。
                assert_eq!(args.len(), 2, "{:?}", args);
                assert!(!args.contains(&"--stdio".to_string()), "pick_source 不应注入 --stdio");
            }
            other => panic!("expected Explicit, got {other:?}"),
        }
    }

    #[test]
    fn to_command_rust_no_stdio_other_langs_stdio() {
        // Bundled（Rust）：无 --stdio —— rust-analyzer 默认即 LSP（stdin/stdout 读
        // Content-Length 帧），1.96+ 显式拒绝 --stdio（unexpected flag）。
        let bundled = ServerSource::Bundled {
            subdir: "rust".into(), binary: "rust-analyzer".into(),
        };
        let (prog, args) = to_command(LanguageId::Rust, &bundled, None);
        assert!(!args.contains(&"--stdio".to_string()), "rust-analyzer 不传 --stdio, args: {:?}", args);
        assert_eq!(prog, "lsp/rust/rust-analyzer");

        // Which（Go）：--stdio 默认（其他 LSP server 仍走 --stdio）。
        let which = ServerSource::Which { binary: "gopls".into() };
        let (prog, args) = to_command(LanguageId::Go, &which, None);
        assert_eq!(prog, "gopls");
        assert!(args.contains(&"--stdio".to_string()), "go args: {:?}", args);

        // Explicit（Rust）：用户 args 原样保留，profile supplement_explicit 不补 --stdio。
        let explicit = ServerSource::Explicit {
            program: "/x/ra".into(),
            args: vec!["--log-file".into(), "/tmp/ra.log".into()],
        };
        let (prog, args) = to_command(LanguageId::Rust, &explicit, None);
        assert_eq!(prog, "/x/ra");
        assert!(!args.contains(&"--stdio".to_string()), "rust explicit 不补 --stdio, args: {:?}", args);
        assert!(args.contains(&"--log-file".to_string()), "rust explicit 保留用户 args, {:?}", args);

        // 守卫：用户显式传的 --stdio 原样保留（不补也不删；兼容旧版 rust-analyzer）。
        let explicit_with_stdio = ServerSource::Explicit {
            program: "/x".into(),
            args: vec!["--stdio".into()],
        };
        let (_, args) = to_command(LanguageId::Rust, &explicit_with_stdio, None);
        let stdio_count = args.iter().filter(|a| a.as_str() == "--stdio").count();
        assert_eq!(stdio_count, 1, "用户传的 --stdio 保留, args: {:?}", args);
    }

    #[test]
    fn empty_program_override_is_ignored() {
        // program 空串的 override 视作未配置 → 落 bundled/which。
        let mut servers = HashMap::new();
        servers.insert("rust".to_string(), ServerOverride { program: "".into(), args: vec![] });
        let settings = AppSettings { lsp: LspSettings { servers }, ..Default::default() };
        let bundled = Some(ServerSource::Bundled {
            subdir: "rust".into(), binary: "rust-analyzer".into(),
        });
        let picked = pick_source(settings.lsp.servers.get("rust"), bundled, None);
        assert!(matches!(picked, Some(ServerSource::Bundled { .. })));
    }
}
