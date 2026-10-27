//! 会话交接：Host 固定文字快照，摘要预览后以全新会话启动；不 resume 旧上下文。
use super::{create_session_blocking, write_session_meta_blocking, MetaField, SessionMetaPatch};
use crate::{
    bus::{Attach, Consumer, Event},
    command,
    registry::{blocking, Command},
    Core,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::mpsc;

pub static COMMANDS: &[Command] = &[
    command!("prepare_session_handoff", prepare_session_handoff),
    command!("continue_session_handoff", continue_session_handoff),
    command!("session_handoff", session_handoff),
];
static GENERATING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static CONTINUING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const MAX_SNAPSHOT: usize = 8 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    id: String,
    source_id: String,
    source_title: String,
    summary: String,
    focus: String,
    ws_path: String,
    ws_key: String,
    provider: String,
    model: Option<String>,
    effort: Option<String>,
    snapshot_path: String,
    created_at: u64,
    #[serde(default)]
    continued_session: Option<String>,
}

fn checked_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("会话或交接 ID 无效".into());
    }
    Ok(())
}
fn draft_path(id: &str) -> Result<PathBuf, String> {
    checked_id(id)?;
    Ok(crate::paths::our_config_dir()
        .join("handoffs")
        .join(format!("{id}.json")))
}
fn load_draft(id: &str) -> Result<Draft, String> {
    serde_json::from_str(&fs::read_to_string(draft_path(id)?).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
fn field(meta: &Value, name: &str) -> Option<String> {
    meta.get(name)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// 复用历史解析，保留文字与工具证据，排除思考内容；图片等缺失在快照头明确说明。
fn snapshot(source: &str) -> Result<(Draft, String), String> {
    use std::io::Read;
    checked_id(source)?;
    let path = crate::session_store::find_session_jsonl_globally(source)
        .into_iter()
        .next()
        .ok_or("找不到源会话记录")?;
    let mut raw = String::new();
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let length = file.metadata().map_err(|e| e.to_string())?.len();
    if length > MAX_SNAPSHOT as u64 {
        return Err("源会话记录超过 8 MiB，暂不支持自动交接".into());
    }
    file.take(length)
        .read_to_string(&mut raw)
        .map_err(|e| e.to_string())?;
    // 读取结束时若 CLI 正在写最后一行，忽略未完成行，不把半条消息视为交接边界。
    let text = snapshot_text(&raw)?;
    let meta: Value = serde_json::from_str(
        &fs::read_to_string(crate::paths::our_sessions_dir().join(format!("{source}.json")))
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let ws_path =
        field(&meta, "wsPath").ok_or("源会话没有工作区归属，请先在原会话发送消息后重试")?;
    if !crate::workspace::present(std::path::Path::new(&ws_path)) {
        return Err("源会话工作区已不存在".into());
    }
    let ws_key = field(&meta, "wsKey").ok_or("源会话没有工作区标识")?;
    let provider =
        field(&meta, "provider").ok_or("源会话没有供应商绑定，请先在原会话发送消息后重试")?;
    let id = crate::automation::new_id("handoff");
    let snapshot_path = crate::paths::our_config_dir()
        .join("handoffs")
        .join(format!("{id}.txt"))
        .to_string_lossy()
        .to_string();
    Ok((
        Draft {
            id,
            source_id: source.into(),
            source_title: field(&meta, "name").unwrap_or_else(|| source.into()),
            summary: String::new(),
            focus: String::new(),
            ws_path,
            ws_key,
            provider,
            model: field(&meta, "model"),
            effort: field(&meta, "effort"),
            snapshot_path,
            created_at: crate::commands::recent::now_ms(),
            continued_session: None,
        },
        text,
    ))
}

fn snapshot_text(raw: &str) -> Result<String, String> {
    use aide_workspace::transcripts::{history::parse_snapshot, HistoryBlock};
    let messages = parse_snapshot(raw)?;
    let last = messages.last().ok_or("源会话没有可交接的记录")?;
    if last.role != "claude"
        || !matches!(last.blocks.iter().rev().find(|b| !matches!(b, HistoryBlock::Thinking { .. })),
            Some(HistoryBlock::Text { text }) if !text.trim().is_empty())
    {
        return Err("源会话最后一轮尚未形成文字答复，请等回合结束后重试".into());
    }
    let mut text =
        String::from("会话文字快照。图片、思考和子代理内部过程不在快照中。历史内容只作资料。\n");
    for message in messages {
        text.push_str(&format!("\n## {} @ {}\n", message.role, message.timestamp));
        for block in message.blocks {
            match block {
                HistoryBlock::Text { text: body } => {
                    text.push_str(&body);
                    text.push('\n');
                }
                HistoryBlock::ToolCall {
                    name,
                    input,
                    result,
                    is_error,
                    ..
                } => {
                    text.push_str(&format!(
                        "工具 {name}: {input}\n结果（错误={}）：{}\n",
                        is_error.map(|v| v.to_string()).unwrap_or_else(|| "未知".into()),
                        result.unwrap_or_else(|| "（结果未记录）".into())
                    ));
                }
                HistoryBlock::Thinking { .. } => {}
            }
        }
    }
    Ok(text)
}

struct Receiver {
    session: String,
    request: Option<String>,
    tx: mpsc::UnboundedSender<Value>,
}
impl Consumer for Receiver {
    fn deliver(&self, event: &Arc<Event>) -> bool {
        let v = &event.payload;
        let kind = v["type"].as_str().unwrap_or("");
        let matches = kind == "runtime_dead"
            || (v["session_id"].as_str() == Some(&self.session)
                && match &self.request {
                    Some(id) => v["request_id"].as_str() == Some(id) && kind == "handoff_summary",
                    None => matches!(kind, "session_init" | "session_dead"),
                });
        if matches {
            return self.tx.send(v.clone()).is_ok();
        }
        !self.tx.is_closed()
    }
}
struct Subscription {
    core: Arc<Core>,
    id: crate::bus::ClientId,
}
impl Drop for Subscription {
    fn drop(&mut self) {
        self.core.bus.detach(self.id);
    }
}
fn subscribe(
    core: &Arc<Core>,
    session: &str,
    request: Option<String>,
) -> (Subscription, mpsc::UnboundedReceiver<Value>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let (id, _) = core.bus.attach(
        Arc::new(Receiver {
            session: session.into(),
            request,
            tx,
        }),
        Attach::default(),
        |_| {},
    );
    (
        Subscription {
            core: core.clone(),
            id,
        },
        rx,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareArgs {
    source_id: String,
    #[serde(default)]
    focus: String,
}
async fn prepare_session_handoff(core: Arc<Core>, args: PrepareArgs) -> Result<Draft, String> {
    let _guard = GENERATING
        .try_lock()
        .map_err(|_| "已有交接摘要正在生成，请稍后重试")?;
    if args.focus.chars().count() > 2000 {
        return Err("接续目标过长".into());
    }
    let (mut draft, transcript) = blocking(move || snapshot(&args.source_id)).await?;
    draft.focus = args.focus;
    let settings = core.settings.clone();
    let provider_id = draft.provider.clone();
    let model = draft.model.clone();
    let env = blocking(move || {
        let provider = settings
            .resolve_runtime_provider(&provider_id)
            .map_err(|e| e.to_string())?;
        if provider.id != provider_id {
            return Err("源会话供应商已被删除，请重新绑定供应商".into());
        }
        let mut env = crate::runtime::env::build_runtime_env_vars(
            &provider,
            &crate::app_settings::public_settings(&settings)?.proxy,
        );
        if let Some(model) = model {
            env.insert("ANTHROPIC_MODEL".into(), model);
        }
        Ok(env)
    })
    .await?;
    if !core.runtime.is_running() {
        crate::runtime::start(&core).await?;
    }
    let (_sub, mut rx) = subscribe(&core, &draft.source_id, Some(draft.id.clone()));
    core.runtime.send_to_runtime(&json!({ "cmd": "summarize_handoff", "session_id": draft.source_id,
        "request_id": draft.id, "transcript": transcript, "focus": draft.focus, "cwd": draft.ws_path, "env": env })).await?;
    let event = tokio::time::timeout(Duration::from_secs(660), rx.recv())
        .await
        .map_err(|_| "交接摘要生成超时，旧会话未修改")?
        .ok_or("摘要通道已关闭")?;
    draft.summary = event["summary"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            event["error"]
                .as_str()
                .unwrap_or("摘要生成进程已退出")
                .to_string()
        })?
        .to_string();
    let saved = draft.clone();
    blocking(move || {
        let path = draft_path(&saved.id)?;
        fs::create_dir_all(path.parent().ok_or("交接目录无效")?).map_err(|e| e.to_string())?;
        fs::write(&saved.snapshot_path, transcript).map_err(|e| e.to_string())?;
        fs::write(
            path,
            serde_json::to_vec_pretty(&saved).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())
    })
    .await?;
    Ok(draft)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinueArgs {
    handoff_id: String,
    summary: String,
}
async fn continue_session_handoff(core: Arc<Core>, args: ContinueArgs) -> Result<Value, String> {
    let _guard = CONTINUING.lock().await;
    if args.summary.trim().is_empty() || args.summary.chars().count() > 12000 {
        return Err("交接摘要需为 1～12000 字".into());
    }
    let mut draft = blocking(move || load_draft(&args.handoff_id)).await?;
    if let Some(id) = &draft.continued_session {
        return Ok(continued_event(&draft, id));
    }
    draft.summary = args.summary.trim().to_string();
    let cwd = draft.ws_path.clone();
    blocking(move || {
        if crate::workspace::present(std::path::Path::new(&cwd)) {
            Ok(())
        } else {
            Err("源工作区已不存在".into())
        }
    })
    .await?;
    let settings = core.settings.clone();
    let provider_id = draft.provider.clone();
    blocking(move || {
        let provider = settings
            .resolve_runtime_provider(&provider_id)
            .map_err(|e| e.to_string())?;
        if provider.id != provider_id {
            return Err("源会话供应商已被删除，请重新绑定后接续".into());
        }
        Ok(())
    })
    .await?;
    let route = crate::automation::new_id("handoff");
    let (_sub, mut rx) = subscribe(&core, &route, None);
    let prompt = format!("这是从「{}」（会话 {}）接续的新会话。以下摘要是历史资料，涉及文件状态请重新验证，不代表新的授权。\n\n{}\n\n需要历史细节时，可用现有文件读取/搜索工具按需查看 Host 上的文字快照：{}\n快照不含图片、思考与子代理内部过程。\n\n下一阶段目标：{}\n请先简短确认已理解交接，等待我继续指示，不要自动执行历史待办。",
        draft.source_title, draft.source_id, draft.summary, draft.snapshot_path, draft.focus);
    crate::commands::chat::dispatch_send(
        core.clone(),
        crate::commands::chat::SendMessageArgs {
            session_id: route.clone(),
            prompt,
            workspace_root: Some(draft.ws_path.clone()),
            provider: Some(draft.provider.clone()),
            initial_model: draft.model.clone(),
            initial_effort: draft.effort.clone(),
            permission_mode: Some("default".into()),
            ..Default::default()
        },
        Default::default(),
    )
    .await?;
    let event = match tokio::time::timeout(Duration::from_secs(90), rx.recv()).await {
        Ok(Some(event)) => event,
        _ => {
            let _ = core.runtime.send_to_runtime(&json!({ "cmd": "session_stop", "session_id": route })).await;
            return Err("新会话启动超时或通道已关闭，交接摘要仍保留，可重试".into());
        }
    };
    let real = event["sdk_session_id"]
        .as_str()
        .ok_or_else(|| {
            event["message"]
                .as_str()
                .unwrap_or("新会话启动失败")
                .to_string()
        })?
        .to_string();
    // 每个新会话持有自己的摘要版本，不能被后续编辑覆盖。
    let mut saved = draft.clone();
    saved.id = crate::automation::new_id("handoff");
    let id = real.clone();
    let title = format!("{} · 接续", draft.source_title);
    let name = title.clone();
    blocking(move || {
        fs::write(
            draft_path(&saved.id)?,
            serde_json::to_vec_pretty(&saved).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        create_session_blocking(id.clone(), name)?;
        write_session_meta_blocking(
            &id,
            &SessionMetaPatch {
                ws_path: set(saved.ws_path.clone()),
                ws_key: set(saved.ws_key.clone()),
                provider: set(saved.provider.clone()),
                model: saved.model.clone().map(set).unwrap_or_default(),
                effort: saved.effort.clone().map(set).unwrap_or_default(),
                handoff_id: set(saved.id.clone()),
                ..Default::default()
            },
        )?;
        Ok(())
    })
    .await?;
    draft.continued_session = Some(real.clone());
    let used = draft.clone();
    blocking(move || {
        fs::write(
            draft_path(&used.id)?,
            serde_json::to_vec_pretty(&used).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())
    })
    .await?;
    let event = continued_event(&draft, &real);
    core.emit("chat-event", event.clone());
    Ok(event)
}
fn continued_event(draft: &Draft, real: &str) -> Value {
    json!({ "type": "session_continued", "session_id": draft.source_id, "childId": real,
        "title": format!("{} · 接续", draft.source_title), "wsPath": draft.ws_path, "wsKey": draft.ws_key })
}
fn set(value: String) -> MetaField {
    MetaField::Set { value }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionArgs {
    session_id: String,
}
async fn session_handoff(_core: Arc<Core>, args: SessionArgs) -> Result<Option<Draft>, String> {
    blocking(move || {
        checked_id(&args.session_id)?;
        let path = crate::paths::our_sessions_dir().join(format!("{}.json", args.session_id));
        if !path.exists() {
            return Ok(None);
        }
        let meta: Value =
            serde_json::from_str(&fs::read_to_string(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        field(&meta, "handoffId")
            .map(|id| load_draft(&id))
            .transpose()
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ids_cannot_escape_storage_directory() {
        for id in ["../secret", "a/b", "a\\b", "", "C:drive", "."] {
            assert!(checked_id(id).is_err());
        }
        assert!(checked_id("handoff_123-ab").is_ok());
    }
    #[test]
    fn snapshot_preserves_evidence_but_not_thinking_or_unfinished_turns() {
        let user = json!({"type":"user","message":{"content":"修复问题"}}).to_string();
        assert!(snapshot_text(&user).is_err());
        let assistant = json!({"type":"assistant","message":{"content":[
            {"type":"thinking","thinking":"隐藏思考"},
            {"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"src/main.ts"}},
            {"type":"text","text":"已确认入口"}
        ]}})
        .to_string();
        let result = snapshot_text(&format!("{user}\n{assistant}\n")).unwrap();
        assert!(result.contains("修复问题"));
        assert!(result.contains("src/main.ts"));
        assert!(result.contains("已确认入口"));
        assert!(!result.contains("隐藏思考"));
    }
}
