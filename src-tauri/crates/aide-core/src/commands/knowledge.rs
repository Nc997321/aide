//! 知识库运行时凭据：桌面前端推送 → 落 `~/.aide/knowledge.json`（dev 档为
//! `~/.aide/knowledge.dev.json`，按构建档位分名，见 `kb_config_path`）→ agent-sidecar 的
//! 进程内 MCP 工具（aide-knowledge）**每次调用现读**。
//!
//! 为什么凭据落文件而不是进 env：Bash 工具子进程会继承 sidecar 的 env，模型跑
//! `env` 就能把 token 带走（红线见 agent-sidecar/src/engine/sessionMetadata.ts）。
//! 这里只把**路径**经 env 交给 sidecar（AIDE_KB_CONFIG_FILE），凭据本体落盘。
//! 为什么独立文件而不写进 state.json：生命周期与并发面都不一样——登出是「删掉这个
//! 文件」，干净利落，不必挤进 state.json 的 load-modify-save 临界区，也不该混进它的
//! 写入序列（一次凭据轮换不值得触发一次全量状态落盘）。风险交底同下：token 明文落盘，
//! 与 localStorage 里已存的明文 token 风险等价（见设计 spec §6.1）。

#[allow(unused_imports)]
use crate::registry::{blocking, Command as HostCommand};
#[allow(unused_imports)]
use crate::{command, Core};
#[allow(unused_imports)]
use serde::Deserialize;
#[allow(unused_imports)]
use std::sync::Arc;

pub static COMMANDS: &[HostCommand] = &[
    command!("knowledge_set_runtime_config", knowledge_set_runtime_config),
];

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

/// 凭据文件名：**按构建档位分名**——dev（debug 构建）= `knowledge.dev.json`，
/// release = `knowledge.json`。
///
/// 为什么分名：localStorage 按 WebView **origin** 分区（dev 前端来自 `http://localhost:1420`，
/// release 来自 Tauri 自己的源），两档各持一份凭据。共用同一文件时后写的一档会覆盖另一档，
/// 表现为「面板显示未登录、agent 却能读写知识库」，或「release 的 agent 以 dev 那次登录的
/// 账号身份读写」（换账号时）。
///
/// 档位判据与 `runtime/mod.rs` 区分 dev/release 取 claude.exe 同源（`debug_assertions`）。
/// 抽成纯函数是为了**两个名字都能被单测覆盖**——`cfg!` 在同一次构建里只可能取一个值，
/// 写进函数体就只有一半可测。
fn config_file_name(debug_build: bool) -> &'static str {
    if debug_build {
        "knowledge.dev.json"
    } else {
        "knowledge.json"
    }
}

/// 凭据文件路径：`~/.aide/knowledge.json`（dev 档为 `knowledge.dev.json`），与
/// state.json 同目录、刻意独立。文件名随构建档位，理由见 `config_file_name`。
pub fn kb_config_path() -> PathBuf {
    crate::paths::our_config_dir().join(config_file_name(cfg!(debug_assertions)))
}

/// 入参 → 动作：登出删文件 / 否则写。分支判定与副作用分离，便于直接单测。
enum ConfigAction {
    Write(Value),
    Delete,
}

/// 纯函数：凭据 JSON 形状（`version` 供将来无痛演进；sidecar 不认识就 fail-closed
/// 当未配置）。token 缺失或全空白 = 登出 → 删文件（绝不把空串写成有效凭据）。
fn config_action(base_url: &str, token: Option<&str>) -> ConfigAction {
    match token.map(str::trim) {
        None | Some("") => ConfigAction::Delete,
        Some(t) => ConfigAction::Write(json!({ "version": 1, "baseUrl": base_url, "token": t })),
    }
}

/// 副作用层：执行动作。删是幂等的（文件不在 = 已是登出态）；写是原子替换。
fn apply_config_action(path: &Path, action: ConfigAction) -> Result<(), String> {
    match action {
        ConfigAction::Delete => {
            if path.exists() {
                fs::remove_file(path)
                    .map_err(|e| format!("Failed to remove knowledge config: {e}"))?;
            }
            Ok(())
        }
        ConfigAction::Write(v) => {
            let content = serde_json::to_string_pretty(&v)
                .map_err(|e| format!("Serialize knowledge config: {e}"))?;
            write_config_atomic(path, &content)
        }
    }
}

/// 先写 .tmp 再 rename。rename 复用 `settings::persist_file`——那里的 Windows
/// 杀软瞬态锁重试是实测踩出来的，不重写一份。
fn write_config_atomic(path: &Path, content: &str) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "knowledge config path has no parent".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create config dir: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, content).map_err(|e| format!("Failed to write knowledge config temp: {e}"))?;
    if let Err(e) = crate::app_settings::persist_file(&tmp, path) {
        // rename 始终失败：清理临时文件，原文件未动
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// 写 / 删知识库凭据。`token` 为 `None` 或空白 = 登出 → 删文件。
///
/// 同步命令：一个几百字节文件的写，达不到冻主线程的量级，按构建期守卫
/// （`scripts/check-sync-io-commands.mjs`）要求埋 `trace_command`——真卡了能点名。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSetRuntimeConfigArgs {
    base_url: String,
    #[serde(default)]
    token: Option<String>,
}

async fn knowledge_set_runtime_config(_core: Arc<Core>, a: KnowledgeSetRuntimeConfigArgs) -> Result<(), String> {
    let KnowledgeSetRuntimeConfigArgs { base_url, token } = a;
    blocking(move || -> Result<(), String> {
    apply_config_action(
        &kb_config_path(),
        config_action(&base_url, token.as_deref()),
    )
}).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logout_when_token_missing_or_blank() {
        assert!(matches!(
            config_action("http://kb:8788", None),
            ConfigAction::Delete
        ));
        assert!(matches!(
            config_action("http://kb:8788", Some("   ")),
            ConfigAction::Delete
        ));
    }

    #[test]
    fn write_carries_version_base_url_and_token() {
        let ConfigAction::Write(v) = config_action("http://kb:8788", Some("tok")) else {
            panic!("expected ConfigAction::Write");
        };
        assert_eq!(v["version"], 1);
        assert_eq!(v["baseUrl"], "http://kb:8788");
        assert_eq!(v["token"], "tok");
    }

    #[test]
    fn config_file_name_is_scoped_to_build_profile() {
        // 纯函数：两个档位名都钉死。cargo test 只跑 debug 档，若把判据写回函数体，
        // 非当前档的那一半名字就永远测不到——这条回答「两个名字各是什么」。
        assert_eq!(config_file_name(true), "knowledge.dev.json");
        assert_eq!(config_file_name(false), "knowledge.json");
    }

    #[test]
    fn kb_config_path_wires_in_the_profile_file_name() {
        // 接线：kb_config_path 真的把当前档位传了下去，而不是自己另写死一个名。
        let name = kb_config_path()
            .file_name()
            .expect("kb_config_path 永远带文件名")
            .to_string_lossy()
            .to_string();
        assert_eq!(name, config_file_name(cfg!(debug_assertions)));
    }

    #[test]
    fn apply_writes_then_deletes_idempotently() {
        let dir = std::env::temp_dir().join(format!("aide-kb-test-{}", std::process::id()));
        let path = dir.join("knowledge.json");
        apply_config_action(&path, config_action("http://kb:8788", Some("tok"))).unwrap();
        assert!(fs::read_to_string(&path)
            .unwrap()
            .contains("\"token\": \"tok\""));
        apply_config_action(&path, config_action("http://kb:8788", None)).unwrap();
        assert!(!path.exists());
        // 再删一次 = 已是登出态，幂等成功（不是错误）
        apply_config_action(&path, config_action("http://kb:8788", None)).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }
}
