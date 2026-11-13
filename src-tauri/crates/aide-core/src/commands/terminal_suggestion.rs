use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::registry::blocking;
use crate::Core;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SuggestArgs {
    shell: String,
    conversation: String,
    turn_id: u64,
    request: String,
    remote_os: Option<String>,
    #[serde(default)]
    history: Vec<HistoryTurn>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryTurn {
    id: u64,
    request: String,
    command: Option<String>,
    submitted_command: Option<String>,
    outcome: HistoryOutcome,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum HistoryOutcome {
    Suggested,
    Submitted,
    Rejected,
    NeedsDetails,
}

pub(super) fn validate_command(command: &str) -> Result<&str, String> {
    let command = command.trim_matches(' ');
    if command.is_empty()
        || command.starts_with("```")
        || command.len() > 8192
        || command.chars().any(|c| {
            c.is_control() || matches!(c, '\u{2028}' | '\u{2029}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
    {
        return Err("命令必须是一行可见文本".into());
    }
    Ok(command)
}

pub(super) fn execution_input(command: &str, bracketed_paste: bool) -> Result<String, String> {
    let command = validate_command(command)?;
    Ok(if bracketed_paste {
        format!("\x1b[200~{command}\x1b[201~\r")
    } else {
        format!("{command}\r")
    })
}

pub(super) async fn suggest(core: Arc<Core>, args: SuggestArgs) -> Result<String, String> {
    validate_conversation(&args.conversation)?;
    let request = args.request.trim();
    if request.is_empty() || request.chars().count() > 1000 || args.shell.len() > 256 {
        return Err("请输入 1～1000 字的终端指令".into());
    }
    let settings = core.settings.clone();
    let (provider_id, env) = blocking(move || {
        let provider = settings.resolve_active_runtime_provider().map_err(|e| e.to_string())?;
        let env = crate::runtime::env::build_runtime_env_vars(
            &provider,
            &crate::app_settings::public_settings(&settings)?.proxy,
        );
        Ok((provider.id, env))
    })
    .await?;
    crate::runtime::start(&core).await?;
    let mut budget = 32_000usize;
    let mut history: Vec<_> = args.history.iter().rev().take_while(|turn| {
        let bytes = turn.request.len()
            .saturating_add(turn.command.as_ref().map_or(0, String::len))
            .saturating_add(turn.submitted_command.as_ref().map_or(0, String::len))
            .saturating_add(96);
        if bytes > budget { return false; }
        budget -= bytes;
        true
    }).collect();
    history.reverse();
    let result = core
        .runtime
        .suggest_terminal_command(json!({
            "cmd": "suggest_terminal_command",
            "conversation": args.conversation,
            "turn_id": args.turn_id,
            "shell": args.shell,
            "os": args.remote_os.as_deref().filter(|os| matches!(*os, "linux" | "macos")).unwrap_or(std::env::consts::OS),
            "request": request,
            "history": history,
            "provider_id": provider_id,
            "env": env,
        }))
        .await?;
    if result == "NO_COMMAND" {
        return Ok(String::new());
    }
    validate_command(&result).map(str::to_owned)
}

fn validate_conversation(key: &str) -> Result<(), String> {
    if key.len() == 32 && key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("终端会话标识无效".into())
    }
}

#[derive(Deserialize)]
pub(super) struct CloseArgs {
    conversation: String,
}

pub(super) async fn close(core: Arc<Core>, args: CloseArgs) -> Result<(), String> {
    validate_conversation(&args.conversation)?;
    if core.runtime.is_running() {
        core.runtime.send_to_runtime(&json!({
            "cmd": "close_terminal_suggestions",
            "conversation": args.conversation,
        })).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn submits_one_line_after_paste_finishes() {
        assert_eq!(execution_input("cd ..", false).unwrap(), "cd ..\r");
        assert_eq!(execution_input("cd ..", true).unwrap(), "\x1b[200~cd ..\x1b[201~\r");
        assert!(execution_input("cd ..\rwhoami", true).is_err());
    }

    #[test]
    fn rejects_terminal_control_input() {
        for command in ["ls\n", "ls\r", "ls\x1b[201~", "ls\u{202e}", "   "] {
            assert!(validate_command(command).is_err(), "{command:?}");
        }
    }
}
