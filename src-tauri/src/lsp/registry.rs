use crate::commands::settings::{AppSettings, ServerOverride};
use crate::lsp::detector::LanguageId;

/// 已解析的 server 启动来源。
#[derive(Debug, Clone)]
pub enum ServerSource {
    /// 随 tauri resources 捆绑：resource_dir/lsp/<subdir>/<binary>。
    Bundled { subdir: String, binary: String },
    /// PATH 上 `which` 发现的二进制。
    Which { binary: String },
    /// 用户设置显式覆盖的 program + args。
    Explicit { program: String, args: Vec<String> },
}

impl ServerSource {
    /// 捆绑 server 的资源子目录 + 二进制名（v1 仅 rust-analyzer / typescript-language-server 捆绑）。
    fn bundled_for(lang: LanguageId) -> Option<(String, String)> {
        let bin = match lang {
            LanguageId::Rust => "rust-analyzer",
            LanguageId::TypeScript | LanguageId::JavaScript => "typescript-language-server",
            _ => return None, // 其余语言 v1 不捆绑，靠 which / 用户覆盖
        };
        let binary = if cfg!(windows) { format!("{bin}.exe") } else { bin.to_string() };
        Some((lang.id_str().to_string(), binary))
    }
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
    let (subdir, binary) = ServerSource::bundled_for(lang)?;
    let res_dir = app.path().resource_dir().ok()?;
    let path = res_dir.join("lsp").join(&subdir).join(&binary);
    if path.exists() {
        Some(ServerSource::Bundled { subdir, binary })
    } else {
        None
    }
}

fn which_source(lang: LanguageId) -> Option<ServerSource> {
    let bin = lang.server_binary()?;
    which::which(bin).ok().map(|_| ServerSource::Which { binary: bin.to_string() })
}

/// 转 (program, args)。program 是要 spawn 的可执行文件路径/名；args 含 `--stdio`。
/// Bundled 的 program 是 dunce 剥前缀后的完整资源路径（调用方在 spawn 时剥，这里只给原路径，
/// 因为 resource_dir 在 resolve 时已是 verbatim；spawn 前由 manager 剥——见 to_spawn_command）。
pub fn to_command(src: &ServerSource) -> (String, Vec<String>) {
    match src {
        ServerSource::Bundled { subdir, binary } => {
            // 完整路径在 manager spawn 时拼 + dunce；这里只给相对定位 + 标准参数。
            // 简化：返回 (binary, [--stdio])，manager 用 resource_dir 拼完整路径。
            // 但 manager 需要知道是 bundled——故 to_command 仅对 Which/Explicit 给完整 program。
            // Bundled 的完整路径拼在 manager（它有 app handle）。
            (format!("lsp/{subdir}/{binary}"), vec!["--stdio".to_string()])
        }
        ServerSource::Which { binary } => (binary.clone(), vec!["--stdio".to_string()]),
        ServerSource::Explicit { program, args } => {
            let mut full = args.clone();
            if !full.iter().any(|a| a == "--stdio") {
                full.push("--stdio".to_string());
            }
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
                // pick_source 只负责选源，不注入 --stdio（那是 to_command 的职责）。
                // 这里只断言用户配置的原始 args 原样透传。
                assert_eq!(args.len(), 2, "{:?}", args);
                assert!(args.contains(&"--log-file".to_string()));
                assert!(args.contains(&"/tmp/ra.log".to_string()));
                assert!(!args.contains(&"--stdio".to_string()), "pick_source 不应注入 --stdio");
            }
            other => panic!("expected Explicit, got {other:?}"),
        }
    }

    #[test]
    fn to_command_injects_stdio() {
        // Bundled：args 含 --stdio。
        let bundled = ServerSource::Bundled {
            subdir: "rust".into(), binary: "rust-analyzer".into(),
        };
        let (prog, args) = to_command(&bundled);
        assert!(args.contains(&"--stdio".to_string()), "bundled args: {:?}", args);
        assert_eq!(prog, "lsp/rust/rust-analyzer");

        // Which：args 含 --stdio。
        let which = ServerSource::Which { binary: "gopls".into() };
        let (prog, args) = to_command(&which);
        assert_eq!(prog, "gopls");
        assert!(args.contains(&"--stdio".to_string()), "which args: {:?}", args);

        // Explicit：用户 args 保留 + --stdio 追加。
        let explicit = ServerSource::Explicit {
            program: "/x/ra".into(),
            args: vec!["--log-file".into(), "/tmp/ra.log".into()],
        };
        let (prog, args) = to_command(&explicit);
        assert_eq!(prog, "/x/ra");
        assert!(args.contains(&"--stdio".to_string()), "explicit args: {:?}", args);
        assert!(args.contains(&"--log-file".to_string()), "explicit args: {:?}", args);

        // 守卫：用户已传 --stdio 时不重复添加。
        let explicit_with_stdio = ServerSource::Explicit {
            program: "/x".into(),
            args: vec!["--stdio".into()],
        };
        let (_, args) = to_command(&explicit_with_stdio);
        let stdio_count = args.iter().filter(|a| a.as_str() == "--stdio").count();
        assert_eq!(stdio_count, 1, "不应重复添加 --stdio, args: {:?}", args);
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
