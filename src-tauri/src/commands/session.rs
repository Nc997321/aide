use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use tauri::State;

use super::{Session, ChatMessageItem, HistoryBlock, LastEventInfo, ChangeRoundData, ChangeFileData, LoadMessagesResult, WorkspaceState, project_root_for_commands, find_session_jsonl_globally, claude_projects_dir, claude_sessions_dir, our_sessions_dir, our_session_name, our_session_is_automation};

/// 扫描目录 + 每个会话读一次 .jsonl 取末条消息，工作区会话多时是实打实的重 IO；
/// 同步 command 跑在主线程上会卡窗口，这里主线程只取工作区快照，扫描进 blocking 线程。
#[tauri::command]
pub async fn list_sessions(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<Vec<Session>, String> {
    let encoded = match workspace_state.key.lock() {
        Ok(guard) => match guard.as_ref() {
            Some(key) => key.clone(),
            None => return Ok(Vec::new()),
        },
        Err(_) => return Ok(Vec::new()),
    };
    let root = project_root_for_commands(&workspace_state);
    tokio::task::spawn_blocking(move || list_sessions_blocking(encoded, root))
        .await
        .map_err(|e| format!("list_sessions task panicked: {}", e))?
}

/// 扫描单个项目目录下的 .jsonl 会话并追加到 sessions（按 session id 去重——
/// 同一工作区可能因目录编码差异分裂成多个目录，见 `resolve_project_dirs`，
/// 防御同一份 transcript 出现在多个目录时重复列出）。
fn scan_project_jsonl_sessions(
    proj_dir: &std::path::Path,
    sessions: &mut Vec<Session>,
) -> Result<(), String> {
    // 目录可能不存在（工作区登记后还没有任何对话），跳过即可
    if !proj_dir.exists() {
        return Ok(());
    }
    let read_dir = fs::read_dir(proj_dir)
        .map_err(|e| format!("Failed to read project dir: {}", e))?;

    for entry in read_dir {
        let Ok(entry) = entry else { continue; };
        let path = entry.path();
        if !path.extension().map(|e| e == "jsonl").unwrap_or(false) {
            continue;
        }
        let session_id = path.file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if session_id.is_empty() || sessions.iter().any(|s| s.id == session_id) {
            continue;
        }
        // 自动化运行产物不进正常会话列表（tags 机制见 our_session_is_automation）
        if our_session_is_automation(&session_id) {
            continue;
        }

        let (name, started_at) = claude_session_meta(&session_id)
            .unwrap_or_else(|| (session_id.clone(), 0));

        let timestamp = if started_at == 0 {
            path.metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0)
        } else {
            started_at
        };

        let display_name = our_session_name(&session_id)
            .unwrap_or(name);

        sessions.push(Session {
            id: session_id,
            name: display_name,
            timestamp,
        });
    }
    Ok(())
}

fn list_sessions_blocking(
    encoded: String,
    root: std::path::PathBuf,
) -> Result<Vec<Session>, String> {
    let mut sessions: Vec<Session> = Vec::new();

    // Scan .jsonl files if the project directory exists (created after first
    // conversation). If it doesn't exist yet, skip to metadata scan — sessions
    // that were started but never had a conversation still have metadata in
    // ~/.aide/claude/sessions/.
    // 同一工作区可能因 SDK 编码差异（`.` → `-`）分裂成多个项目目录，全部合并扫描。
    for proj_dir in super::resolve_project_dirs(&claude_projects_dir(), &encoded) {
        scan_project_jsonl_sessions(&proj_dir, &mut sessions)?;
    }

    // Second pass: scan ~/.aide/claude/sessions/ for sessions that have metadata
    // but no .jsonl file yet (Claude started, no conversation happened).
    // These sessions won't appear in the project dir scan above.
    let root_normalized = normalize_path_for_compare(&root.to_string_lossy());
    let sessions_dir = claude_sessions_dir();
    if sessions_dir.exists() {
        if let Ok(read_dir) = fs::read_dir(&sessions_dir) {
            for entry in read_dir {
                let Ok(entry) = entry else { continue; };
                let path = entry.path();
                if path.extension().map(|e| e == "json").unwrap_or(false) {
                    let Ok(content) = fs::read_to_string(&path) else { continue; };
                    let Ok(v) = serde_json::from_str::<Value>(&content) else { continue; };

                    let session_cwd = v.get("cwd").and_then(|c| c.as_str()).unwrap_or("");
                    if normalize_path_for_compare(session_cwd) != root_normalized {
                        continue;
                    }

                    let session_id = v.get("sessionId").and_then(|s| s.as_str()).unwrap_or("");
                    if session_id.is_empty() {
                        continue;
                    }

                    // Skip if already in the list (has a .jsonl file)
                    if sessions.iter().any(|s| s.id == session_id) {
                        continue;
                    }

                    // 自动化运行产物不进正常会话列表
                    if our_session_is_automation(session_id) {
                        continue;
                    }

                    let name = v.get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("未命名")
                        .to_string();
                    let started_at = v.get("startedAt").and_then(|t| t.as_u64()).unwrap_or(0);
                    let display_name = our_session_name(&session_id).unwrap_or(name);

                    sessions.push(Session {
                        id: session_id.to_string(),
                        name: display_name,
                        timestamp: started_at,
                    });
                }
            }
        }
    }

    sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(sessions)
}

/// 创建会话元数据。调用方传入 id——发消息、拿到 SDK 返回的真实 session id
/// 之后才会调用这个命令（见 CLAUDE.md「会话 ID 生命周期」），所以这里的 id
/// 从一开始就是终身 id，不存在草稿 id 需要事后改名的情况。
#[tauri::command]
pub fn create_session(id: String, name: String) -> Result<Session, String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dir = our_sessions_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create sessions dir: {}", e))?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    let meta = serde_json::json!({ "id": id, "name": name, "createdAt": timestamp, "nameSource": "auto" });
    let path = dir.join(format!("{}.json", id));
    fs::write(&path, serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Failed to write session: {}", e))?;

    Ok(Session {
        id,
        name,
        timestamp,
    })
}

#[tauri::command]
pub fn delete_session(
    _workspace_state: State<'_, WorkspaceState>,
    id: String,
) -> Result<(), String> {
    let our_path = our_sessions_dir().join(format!("{}.json", id));
    if our_path.exists() {
        fs::remove_file(&our_path).map_err(|e| format!("Failed to delete metadata: {}", e))?;
    }

    // Remove the transcript wherever Claude actually stored it. `claude --resume
    // <id>` is global, so a session's .jsonl may live under a project folder whose
    // encoding differs from the cwd-encoding Aide would compute (e.g. Claude once
    // encoded '.' as '-' while Aide keeps it). Searching by id across all project
    // folders — instead of re-encoding the cwd — guarantees we delete the real
    // file rather than silently no-op'ing and leaving it resumable.
    for jsonl in super::find_session_jsonl_globally(&id) {
        fs::remove_file(&jsonl).map_err(|e| format!("Failed to delete session file: {}", e))?;
        // Drop the per-session sibling directory (<id>/, holds subagent transcripts)
        // if Claude created one next to the .jsonl.
        if let Some(dir) = jsonl.parent().map(|p| p.join(&id)) {
            if dir.is_dir() {
                let _ = fs::remove_dir_all(&dir);
            }
        }
    }

    let ses_dir = claude_sessions_dir();
    if ses_dir.exists() {
        if let Ok(read_dir) = fs::read_dir(&ses_dir) {
            for entry in read_dir {
                let Ok(entry) = entry else { continue; };
                let path = entry.path();
                if path.extension().map(|e| e == "json").unwrap_or(false) {
                    if let Ok(content) = fs::read_to_string(&path) {
                        if let Ok(v) = serde_json::from_str::<Value>(&content) {
                            if v.get("sessionId").and_then(|s| s.as_str()) == Some(&id) {
                                let _ = fs::remove_file(&path);
                            }
                        }
                    }
                }
            }
        }
    }

    // 同步移除「最近访问」中已删会话（双保险，配合 list_recent 自愈）。
    let _ = super::recent::remove_recent_session(id);

    Ok(())
}

#[tauri::command]
pub fn rename_session(id: String, name: String) -> Result<(), String> {
    let dir = our_sessions_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create sessions dir: {}", e))?;
    let path = dir.join(format!("{}.json", id));

    let meta = if path.exists() {
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read: {}", e))?;
        let mut v: Value = serde_json::from_str(&content)
            .map_err(|e| format!("Invalid JSON: {}", e))?;
        v["name"] = Value::String(name.clone());
        v
    } else {
        serde_json::json!({ "id": id, "name": name })
    };
    // 手动重命名：标记 nameSource=manual，此后自动生成的标题一律不得覆盖
    // （auto_rename_session 据此拒写）。
    let mut meta = meta;
    meta["nameSource"] = Value::String("manual".to_string());

    fs::write(&path, serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Failed to write: {}", e))
}

/// 自动命名（sidecar 首轮对话后生成的会话标题）：仅当用户没手动命名过时采纳。
/// `nameSource == "manual"` 直接拒写返回 false；缺该字段的旧数据视为 "auto"。
/// 判断 + 写入收在这一个函数里，防「自动标题生成的几秒内用户恰好手动改名」
/// 的竞态——前端拿到 true 才更新 UI。
/// 磁盘 IO 离开主线程（同 set_session_model，见 CLAUDE.md「同步 command 禁止重 IO」）。
#[tauri::command]
pub async fn auto_rename_session(id: String, name: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || auto_rename_session_blocking(&id, &name))
        .await
        .map_err(|e| format!("auto_rename_session task panicked: {}", e))?
}

fn auto_rename_session_blocking(id: &str, name: &str) -> Result<bool, String> {
    let dir = our_sessions_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create sessions dir: {}", e))?;
    let path = dir.join(format!("{}.json", id));

    let mut v: Value = if path.exists() {
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read: {}", e))?;
        serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {}", e))?
    } else {
        serde_json::json!({ "id": id })
    };

    if v.get("nameSource").and_then(|s| s.as_str()) == Some("manual") {
        return Ok(false);
    }
    v["name"] = Value::String(name.to_string());
    v["nameSource"] = Value::String("auto".to_string());

    fs::write(&path, serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Failed to write: {}", e))?;
    Ok(true)
}

/// 记住会话的模型选择：merge 写进会话元数据 `<id>.json` 的 `model` 字段
/// （与 rename_session 同一模式），重开会话/重启 app 后由前端恢复选择器。
/// model 为空 = 清除（跟随 provider 默认）。磁盘 IO 离开主线程（杀软扫描
/// 小文件也可能堵，见 CLAUDE.md「同步 command 禁止重 IO」）。
#[tauri::command]
pub async fn set_session_model(id: String, model: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let dir = our_sessions_dir();
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create sessions dir: {}", e))?;
        let path = dir.join(format!("{}.json", id));

        let mut v: Value = if path.exists() {
            let content = fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read: {}", e))?;
            serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {}", e))?
        } else {
            serde_json::json!({ "id": id })
        };
        if model.is_empty() {
            v.as_object_mut().map(|o| o.remove("model"));
        } else {
            v["model"] = Value::String(model);
        }

        fs::write(&path, serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?)
            .map_err(|e| format!("Failed to write: {}", e))
    })
    .await
    .map_err(|e| format!("set_session_model task panicked: {}", e))?
}

/// 读回会话记住的模型选择；没有元数据文件或没记过 → None。
#[tauri::command]
pub async fn session_model(id: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let path = our_sessions_dir().join(format!("{}.json", id));
        if !path.exists() {
            return Ok(None);
        }
        let content = fs::read_to_string(&path).map_err(|e| format!("Failed to read: {}", e))?;
        let v: Value = serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {}", e))?;
        Ok(v
            .get("model")
            .and_then(|m| m.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string()))
    })
    .await
    .map_err(|e| format!("session_model task panicked: {}", e))?
}

/// 记住会话的 effort 选择：merge 写进会话元数据 `<id>.json` 的 `effort` 字段
/// （与 set_session_model 同一模式），重开会话/重启 app 后由前端恢复选择器。
/// effort 为空 = 清除（退回 provider 默认 / high）。磁盘 IO 离开主线程。
#[tauri::command]
pub async fn set_session_effort(id: String, effort: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let dir = our_sessions_dir();
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create sessions dir: {}", e))?;
        let path = dir.join(format!("{}.json", id));

        let mut v: Value = if path.exists() {
            let content = fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read: {}", e))?;
            serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {}", e))?
        } else {
            serde_json::json!({ "id": id })
        };
        if effort.is_empty() {
            v.as_object_mut().map(|o| o.remove("effort"));
        } else {
            v["effort"] = Value::String(effort);
        }

        fs::write(&path, serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?)
            .map_err(|e| format!("Failed to write: {}", e))
    })
    .await
    .map_err(|e| format!("set_session_effort task panicked: {}", e))?
}

/// 读回会话记住的 effort 选择；没有元数据文件或没记过 → None。
#[tauri::command]
pub async fn session_effort(id: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let path = our_sessions_dir().join(format!("{}.json", id));
        if !path.exists() {
            return Ok(None);
        }
        let content = fs::read_to_string(&path).map_err(|e| format!("Failed to read: {}", e))?;
        let v: Value = serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {}", e))?;
        Ok(v
            .get("effort")
            .and_then(|m| m.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string()))
    })
    .await
    .map_err(|e| format!("session_effort task panicked: {}", e))?
}

/// 记住会话 spawn 时绑定的供应商 id：merge 写进会话元数据 `<id>.json` 的 `provider`
/// 字段（与 set_session_model / set_session_effort 同一模式），重开 app 后由前端恢复
/// 会话的供应商绑定（只恢复该会话绑定，不动全局激活供应商）。provider 为空 = 清除。
/// 磁盘 IO 离开主线程（同 set_session_model，见 CLAUDE.md「同步 command 禁止重 IO」）。
#[tauri::command]
pub async fn set_session_provider(id: String, provider: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let dir = our_sessions_dir();
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create sessions dir: {}", e))?;
        let path = dir.join(format!("{}.json", id));

        let mut v: Value = if path.exists() {
            let content = fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read: {}", e))?;
            serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {}", e))?
        } else {
            serde_json::json!({ "id": id })
        };
        if provider.is_empty() {
            v.as_object_mut().map(|o| o.remove("provider"));
        } else {
            v["provider"] = Value::String(provider);
        }

        fs::write(&path, serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?)
            .map_err(|e| format!("Failed to write: {}", e))
    })
    .await
    .map_err(|e| format!("set_session_provider task panicked: {}", e))?
}

/// 读回会话绑定的供应商 id；没有元数据文件或没记过 → None（前端回落全局激活供应商）。
/// 字段读取与 send_message 的元数据兜底共用 `our_session_provider_field` 同一口径；
/// 读取失败降级为 None（与缺文件同语义，前端已 catch 兜底）。
#[tauri::command]
pub async fn session_provider(id: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || Ok(crate::commands::our_session_provider_field(&id)))
        .await
        .map_err(|e| format!("session_provider task panicked: {}", e))?
}

/// transcript 会随会话增长到多 MB，整读 + 逐行解析必须离开主线程（切会话时触发，
/// 同步跑等于切一次长会话卡一次窗口）。
///
/// 分页参数（均为可选，缺省 = 现有整读行为，向后兼容）：
/// - `offset_bytes`：从该字节位置**往前**（向文件头方向）取一页；None = 从文件尾取。
///   游标语义：下一页从「页首真实 user 行的起始字节」继续往前读，页与页之间无重复。
/// - `limit`：单页**字节预算**（UTF-8 行字节累计；至少 1 条保底）。2026-08-26 由
///   「目标条数」改字节预算：窗口/取回按内容量自适应（大 tool_result 占预算多则少取），
///   与前端 useMessageWindow 的字节预算窗口对齐；页首裁到真实 user 行保证回合完整。
#[tauri::command]
pub async fn load_messages(
    _workspace_state: State<'_, WorkspaceState>,
    session_id: String,
    offset_bytes: Option<u64>,
    limit: Option<u32>,
) -> Result<LoadMessagesResult, String> {
    tokio::task::spawn_blocking(move || load_messages_blocking(session_id, offset_bytes, limit))
        .await
        .map_err(|e| format!("load_messages task panicked: {}", e))?
}

fn load_messages_blocking(
    session_id: String,
    offset_bytes: Option<u64>,
    limit: Option<u32>,
) -> Result<LoadMessagesResult, String> {
    let Some(jsonl_path) = find_session_jsonl_globally(&session_id).into_iter().next() else {
        return Ok(LoadMessagesResult { messages: Vec::new(), next_offset_bytes: 0, end_offset_bytes: 0 });
    };

    let file = fs::File::open(&jsonl_path)
        .map_err(|e| format!("Failed to open session file: {}", e))?;
    let file_len = file
        .metadata()
        .map_err(|e| format!("Failed to read metadata: {}", e))?
        .len();
    match limit {
        None => read_all_messages(file, file_len),
        Some(limit) => read_page_backwards(&file, file_len, offset_bytes, limit),
    }
}

/// 整读全部行（缺省路径，与分页前的行为一致）。end_offset_bytes = file_len
/// （整页的排他末尾），前端页级回收重取协议要求任何路径都给真实末尾字节。
fn read_all_messages(file: fs::File, file_len: u64) -> Result<LoadMessagesResult, String> {
    let reader = BufReader::new(file);
    let lines: Vec<String> = reader
        .lines()
        .enumerate()
        .map(|(i, l)| l.map_err(|e| format!("Read error at line {}: {}", i, e)))
        .collect::<Result<_, _>>()?;
    Ok(LoadMessagesResult {
        messages: parse_transcript_lines(&lines),
        next_offset_bytes: 0,
        end_offset_bytes: file_len,
    })
}

/// 从 `offset_bytes`（缺省 = 文件尾）往前按字节游标取一页，直到页的「行字节累计」
/// ≥ limit_bytes 或到文件头。limit 是**字节预算**（不是条数）：单条超大消息
/// （如 MB 级 tool_result）也按最新 1 条保底返回；预算按「消息占的行字节」累计
/// （UTF-8 len），页首必须是真实 user 行（回合起点），否则继续往前扩。返回的
/// `next_offset_bytes` 是页首行的起始字节，下一页从它继续往前读（不包含该行，页间无重复）。
fn read_page_backwards(
    file: &fs::File,
    file_len: u64,
    offset_bytes: Option<u64>,
    limit_bytes: u32,
) -> Result<LoadMessagesResult, String> {
    // 越界游标（revertRound 截断后旧游标失效） clamp 到文件尾 → 空页
    let end = offset_bytes.unwrap_or(file_len).min(file_len);
    let mut bytes: Vec<u8> = Vec::new();
    let mut cursor = end;
    loop {
        if cursor > 0 {
            let (chunk, chunk_start) = read_chunk_backwards(file, cursor)?;
            bytes.splice(0..0, chunk);
            cursor = chunk_start;
        }
        let (lines, starts) = split_lines(&bytes, cursor);
        let parsed = parse_transcript_lines_with_starts(&lines);
        let (messages, page_start, used_bytes) = trim_to_bytes(&parsed, &lines, limit_bytes);
        if used_bytes >= limit_bytes as usize || cursor == 0 {
            let next_offset = starts.get(page_start).copied().unwrap_or(0);
            // 尾部探测：下一页区域较小（≤1MB，接近文件头）且无可解析消息时直接归零——
            // 否则前端「上方还有更早消息」按钮在空区域前悬空（点击/上滚后才发现
            // 没有内容，2026-08-26 用户实锤「误报」：文件头多为 queue-operation /
            // 图片消息等不可渲染行，如 ed6377db 尾页 next=278 区域全空）。
            let next_offset = if next_offset > 0 && next_offset <= CHUNK_SIZE
                && !region_has_parseable_messages(file, next_offset)?
            {
                0
            } else {
                next_offset
            };
            return Ok(LoadMessagesResult { messages, next_offset_bytes: next_offset, end_offset_bytes: end });
        }
    }
}

/// `[0, end)` 区域是否存在「能解析成历史消息」的行（轻量判定，与
/// `parse_transcript_lines_with_starts` 的产出规则一致：type=user/assistant、
/// 非 synthetic、content 含 text/thinking/非子代理 tool_use 块）。供
/// `read_page_backwards` 尾部探测——空区域直接归零游标，前端「还有更早」入口
/// 不悬空。仅当 `end` 较小（文件头附近）时调用，成本 ≤1 次 1MB 读 + 逐行判定。
fn region_has_parseable_messages(file: &fs::File, end: u64) -> Result<bool, String> {
    if end == 0 {
        return Ok(false);
    }
    let mut f = file;
    f.seek(SeekFrom::Start(0)).map_err(|e| format!("Failed to seek: {}", e))?;
    let mut buf = vec![0u8; end as usize];
    f.read_exact(&mut buf).map_err(|e| format!("Failed to read region: {}", e))?;
    for line in split_lines(&buf, 0).0 {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        let msg_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if msg_type == "user" && is_synthetic_user_entry(&v) {
            continue;
        }
        let Some(content) = v.get("message").and_then(|m| m.get("content")) else {
            continue;
        };
        let has_block = match content {
            Value::String(s) => !s.is_empty(),
            Value::Array(blocks) => blocks.iter().any(|b| match b.get("type").and_then(|t| t.as_str()) {
                Some("text") | Some("thinking") => true,
                Some("tool_use") => {
                    let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("");
                    !SUBAGENT_TOOL_NAMES.contains(&name)
                }
                _ => false,
            }),
            _ => false,
        };
        if has_block {
            return Ok(true);
        }
    }
    Ok(false)
}

/// 分页回读块大小（1MB）：read_chunk_backwards 单块；read_page_backwards 用它
/// 限定「尾部探测」范围（≤1MB 的 next_offset 才探测，更远必然还有内容）。
const CHUNK_SIZE: u64 = 1024 * 1024;

/// 从 `cursor` 往回读一块（1MB），返回 (字节, 块起始位置)。cursor=0 时调用方不调。
fn read_chunk_backwards(file: &fs::File, cursor: u64) -> Result<(Vec<u8>, u64), String> {
    let start = cursor.saturating_sub(CHUNK_SIZE);
    let len = (cursor - start) as usize;
    let mut buf = vec![0u8; len];
    let mut f = file;
    f.seek(SeekFrom::Start(start)).map_err(|e| format!("Failed to seek: {}", e))?;
    f.read_exact(&mut buf).map_err(|e| format!("Failed to read chunk: {}", e))?;
    Ok((buf, start))
}

/// 按字节拆行 + 每行起始字节（文件绝对位置）。从末尾往前找 `\n` 分隔；末尾不完整行
/// （游标所在行 / EOF 半截行）丢弃——它属于下一页，本页不解析。0x0A 不会出现在
/// 多字节 UTF-8 序列中间，按字节找 `\n` 永远安全。
fn split_lines(bytes: &[u8], base_offset: u64) -> (Vec<String>, Vec<u64>) {
    let mut lines = Vec::new();
    let mut starts = Vec::new();
    let mut line_start = 0usize;
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'\n' {
            if let Ok(s) = std::str::from_utf8(&bytes[line_start..i]) {
                lines.push(s.to_string());
                starts.push(base_offset + line_start as u64);
            }
            line_start = i + 1;
        }
    }
    (lines, starts)
}

/// 保留最新的「行字节累计 ≤ limit_bytes」的消息，且页首（第一条）必须是真实 user
/// 消息（完整回合起点）。字节按「消息占的行」累计（合并的 assistant 连续行计为该
/// 消息的行字节；tool_result-only 行不成消息不计）；最新 1 条无条件保底（单条超大
/// 消息也返回，避免「页空导致上滚取不到任何内容」）。若页首不是 user（如 revertRound
/// 截断落在回合中间），从首条起逐条裁掉、保留更少，直到页首是 user；范围内全非
/// user → 返回空（调用方继续往前读更早的块，到文件头终止）。
/// 返回 (消息, 页首消息的起始行号, 页累计字节)。
fn trim_to_bytes(
    parsed: &[(ChatMessageItem, usize)],
    lines: &[String],
    limit_bytes: u32,
) -> (Vec<ChatMessageItem>, usize, usize) {
    let mut start = parsed.len();
    let mut bytes = 0usize;
    for idx in (0..parsed.len()).rev() {
        let (_, line_idx) = parsed[idx];
        let next_line = parsed.get(idx + 1).map(|(_, li)| *li).unwrap_or(lines.len());
        let msg_bytes: usize = lines[line_idx..next_line].iter().map(|l| l.len()).sum();
        // 最新一条保底：超预算也含（用户打开必须能看到最新回复）
        if bytes + msg_bytes > limit_bytes as usize && idx < parsed.len() - 1 {
            break;
        }
        bytes += msg_bytes;
        start = idx;
    }
    // 页首裁到真实 user 行（完整回合起点；裁掉的行字节从累计里减掉，返回的 used
    // 才代表页的真实预算占用）。
    // 预算内找不到 user 行时（长会话尾部工具轮密集，256KB 预算内可能没有人类提问）
    // **保留全部**、页首退回非 user——返回空页会让 nextOffset=0、hasMore 变假，
    // 前端「无法继续往上翻」（实测：字节预算比条数页更易触发，见 spec P1-1 补缺）。
    let original_start = start;
    let bytes_before_trim = bytes;
    while start < parsed.len() && parsed[start].0.role != "user" {
        let (_, line_idx) = parsed[start];
        let next_line = parsed.get(start + 1).map(|(_, li)| *li).unwrap_or(lines.len());
        bytes -= lines[line_idx..next_line].iter().map(|l| l.len()).sum::<usize>();
        start += 1;
    }
    if start >= parsed.len() {
        start = original_start; // 预算内无 user：页 = 预算内全部（页首可非 user，游标继续往前）
        bytes = bytes_before_trim;
    }
    let messages = parsed[start..].iter().map(|(m, _)| m.clone()).collect();
    let page_start = parsed.get(start).map(|(_, i)| *i).unwrap_or(0);
    (messages, page_start, bytes)
}

/// Agent/Task 是子代理调用（CC v2.1.63 把 Task 改名成 Agent，两个都认，跟
/// agent-sidecar/src/subagents.ts 的 SUBAGENT_TOOL_NAMES 保持同一份清单——两边
/// 语言不同没法共享常量，靠注释手动同步）。这次历史重建不管子代理：它们内部的
/// 分步进度 Claude CLI 从不落盘，做了也补不全，维持原有降级行为——整段跳过。
const SUBAGENT_TOOL_NAMES: [&str; 2] = ["Agent", "Task"];

/// 把 Claude CLI 落盘的会话 `.jsonl`（每行一条消息）解析成前端要渲染的历史消息，
/// 按原始顺序重建 text/tool_call 两种内容块（`HistoryBlock`）。从 `load_messages`
/// 抽出来是纯函数、不摸文件系统，方便直接拿假 transcript 单测。
///
/// 两遍扫描：tool_result 落在稍后（也可能更早，顺序不保证）的另一行 user 消息里，
/// 必须先扫一遍全量建好 `tool_use_id → (content, is_error)` 的表，再回填进对应的
/// tool_call 块，不能假设 tool_result 总跟在 tool_use 后面紧挨着那一行。
fn parse_transcript_lines(lines: &[String]) -> Vec<ChatMessageItem> {
    parse_transcript_lines_with_starts(lines).into_iter().map(|(m, _)| m).collect()
}

/// `parse_transcript_lines` 的变体：额外记录每条消息的起始行号（相对收集行），
/// 供字节游标分页定位页首。原函数改为调用它并丢弃行号，现有测试零改动。
fn parse_transcript_lines_with_starts(lines: &[String]) -> Vec<(ChatMessageItem, usize)> {
    let mut tool_results: std::collections::HashMap<String, (String, bool)> =
        std::collections::HashMap::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("user") {
            continue;
        }
        let Some(arr) = v
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        else {
            continue;
        };
        for block in arr {
            if block.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                continue;
            }
            let Some(tool_use_id) = block.get("tool_use_id").and_then(|t| t.as_str()) else {
                continue;
            };
            let is_error = block.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false);
            let content = match block.get("content") {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Array(parts)) => parts
                    .iter()
                    .filter_map(|c| c.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join(""),
                _ => String::new(),
            };
            tool_results.insert(tool_use_id.to_string(), (content, is_error));
        }
    }

    let mut messages: Vec<(ChatMessageItem, usize)> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let msg_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let role = match msg_type {
            "user" => "user",
            "assistant" => "claude",
            _ => continue,
        };
        // "user" 类型 JSONL 行不都是人类打字:Skill 注入(isMeta)、中断占位符
        // (interruptedMessageId)、压缩摘要(isCompactSummary)、后台任务通知
        // (origin.kind = "task-notification")都以 role:"user" 落盘,但不是
        // 人说的话——不过滤会把这些内容渲染成用户气泡,造成"这不是我说的"的假象。
        if role == "user" && is_synthetic_user_entry(&v) {
            continue;
        }
        let Some(content_val) = v.get("message").and_then(|m| m.get("content")) else {
            continue;
        };

        let blocks: Vec<HistoryBlock> = if let Some(s) = content_val.as_str() {
            if s.is_empty() {
                Vec::new()
            } else {
                vec![HistoryBlock::Text { text: s.to_string() }]
            }
        } else if let Some(arr) = content_val.as_array() {
            arr.iter()
                .filter_map(|block| match block.get("type").and_then(|t| t.as_str()) {
                    Some("text") => block
                        .get("text")
                        .and_then(|t| t.as_str())
                        .map(|t| HistoryBlock::Text { text: t.to_string() }),
                    Some("thinking") => block
                        .get("thinking")
                        .and_then(|t| t.as_str())
                        .map(|t| HistoryBlock::Thinking { text: t.to_string() }),
                    Some("tool_use") => {
                        let id = block.get("id").and_then(|t| t.as_str())?.to_string();
                        let name = block.get("name").and_then(|t| t.as_str())?.to_string();
                        if SUBAGENT_TOOL_NAMES.contains(&name.as_str()) {
                            return None;
                        }
                        let input = block.get("input").cloned().unwrap_or(Value::Null);
                        let (result, is_error) = tool_results
                            .get(&id)
                            .map(|(c, e)| (Some(c.clone()), Some(*e)))
                            .unwrap_or((None, None));
                        Some(HistoryBlock::ToolCall { id, name, input, result, is_error })
                    }
                    // 图片等其余 block 类型：维持原有降级行为，暂不重建。
                    _ => None,
                })
                .collect()
        } else {
            Vec::new()
        };

        if blocks.is_empty() {
            continue;
        }
        // 同一回合的 assistant 在 transcript 里逐 chunk 各占一行（一段文本、一次
        // 工具调用各一行），回合之间必有真实 user 行隔开（tool_result-only 和合成
        // user 行在上面已被跳过，不会误隔断）。连续的 assistant 行合并回一条消息，
        // 对齐实时路径「一个回合一条 assistant 消息」的形状——否则重开历史会话时
        // 一个回合的连续工具调用被拆成 N 条消息，前端的消息内分组（ToolCallGroup）
        // 各自成组，摘要退化成 N 个「1 次工具调用」。
        if role == "claude" {
            if let Some(last) = messages.last_mut() {
                if last.0.role == "claude" {
                    last.0.blocks.extend(blocks);
                    continue;
                }
            }
        }
        messages.push((ChatMessageItem { role: role.to_string(), blocks, timestamp: i as u64 }, i));
    }

    messages
}

/// Whether a raw JSONL "user"-type entry is SDK/CLI-synthesized rather than
/// something the human actually typed (Skill injections, interrupt
/// placeholders, compaction summaries, background task notifications).
/// Confirmed against real transcripts: genuine typed messages never carry
/// these markers, and carrying one is never a byproduct of genuine input.
fn is_synthetic_user_entry(v: &Value) -> bool {
    if v.get("isMeta").and_then(|b| b.as_bool()).unwrap_or(false) {
        return true;
    }
    if v.get("interruptedMessageId").is_some() {
        return true;
    }
    if v.get("isCompactSummary").and_then(|b| b.as_bool()).unwrap_or(false) {
        return true;
    }
    if let Some(kind) = v.get("origin").and_then(|o| o.get("kind")).and_then(|k| k.as_str()) {
        if kind != "human" {
            return true;
        }
    }
    false
}

/// Normalize a filesystem path so two paths pointing to the same location
/// compare equal: strip trailing separator, use forward slashes, lowercase.
fn normalize_path_for_compare(p: &str) -> String {
    p.trim_end_matches(['/', '\\'])
        .replace('\\', "/")
        .to_lowercase()
}

/// 同 load_messages：整读 .jsonl 再反向扫描，转 blocking 线程。
#[tauri::command]
pub async fn session_last_event(
    _workspace_state: State<'_, WorkspaceState>,
    session_id: String,
) -> Result<LastEventInfo, String> {
    tokio::task::spawn_blocking(move || session_last_event_blocking(session_id))
        .await
        .map_err(|e| format!("session_last_event task panicked: {}", e))?
}

fn session_last_event_blocking(session_id: String) -> Result<LastEventInfo, String> {
    let Some(jsonl_path) = find_session_jsonl_globally(&session_id).into_iter().next() else {
        return Ok(LastEventInfo { event_type: None, stop_reason: None, timestamp: None });
    };

    let file = fs::File::open(&jsonl_path)
        .map_err(|e| format!("Failed to open session file: {}", e))?;
    let reader = BufReader::new(file);

    // Scan lines in reverse to find the last meaningful conversation event
    // (assistant or user). The actual last line is often a system or
    // file-history-snapshot event, which doesn't tell us if Claude is done.
    let lines: Vec<String> = reader.lines().filter_map(|l| l.ok()).collect();
    for line in lines.iter().rev() {
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            let event_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if event_type == "assistant" || event_type == "user" {
                let stop_reason = v.get("message")
                    .and_then(|m| m.get("stop_reason"))
                    .and_then(|s| s.as_str())
                    .map(|s| s.to_string());
                let timestamp = v.get("timestamp").and_then(|t| t.as_str()).map(|s| s.to_string());
                return Ok(LastEventInfo {
                    event_type: Some(event_type.to_string()),
                    stop_reason,
                    timestamp,
                });
            }
        }
    }
    // No conversation events found — treat as empty
    Ok(LastEventInfo { event_type: None, stop_reason: None, timestamp: None })
}

/// 每轮 Claude 回完都会调用一次（`useConversationChanges.captureChanges → save`），
/// 把累积的全部 `rounds` 序列化落盘。同步版是 2026-07-08 第二次真实冻结的根因：
/// `serde_json::to_string_pretty(&rounds)`（随会话变长，CPU 满核序列化）+ `fs::write`
/// （杀软实时扫描/磁盘争抢时可拖到 27s）两段式堵死 Tauri 主线程，报告实锤 `pending`
/// 单调涨 + `aide.exe` 首帧 100% CPU。和 `session_jsonl_size` 同一类反模式（见
/// CLAUDE.md「同步 command 禁止重 IO」），一并改 async + spawn_blocking。
#[tauri::command]
pub async fn load_session_changes(session_id: String) -> Result<Vec<ChangeRoundData>, String> {
    tokio::task::spawn_blocking(move || load_session_changes_blocking(session_id))
        .await
        .map_err(|e| format!("load_session_changes task panicked: {}", e))?
}

/// changes 文件格式（2026-08-26 起）：
/// - 全量覆盖（save_session_changes）写 JSONL：每行一个 round 的 compact JSON + 末尾换行。
///   比旧 `to_string_pretty` 省序列化 CPU（compact 单行 vs pretty 多行）+ 与 append 格式统一。
/// - 追加（append_session_change）在文件尾 append 一行，O(1) 落盘——每轮 captureChanges
///   不再整份 rounds 重序列化重写（§10.1 顺手优化：把 save_session_changes 每轮 O(总轮数)
///   降为 O(1)）。
/// - 读取兼容旧 pretty 数组：文件以 '[' 开头 → 旧格式整读 from_str；否则 JSONL 逐行 parse。
fn load_session_changes_blocking(session_id: String) -> Result<Vec<ChangeRoundData>, String> {
    let path = our_sessions_dir().join(format!("{}-changes.json", session_id));
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read changes: {}", e))?;
    let trimmed = content.trim_start();
    if trimmed.starts_with('[') {
        // 旧版 pretty 数组格式（2026-08-26 之前）
        return serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse changes: {}", e));
    }
    let mut rounds = Vec::new();
    for (i, line) in content.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let round: ChangeRoundData = serde_json::from_str(line)
            .map_err(|e| format!("Failed to parse changes line {}: {}", i + 1, e))?;
        rounds.push(round);
    }
    Ok(rounds)
}

#[tauri::command]
pub async fn save_session_changes(session_id: String, rounds: Vec<ChangeRoundData>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || save_session_changes_blocking(session_id, rounds))
        .await
        .map_err(|e| format!("save_session_changes task panicked: {}", e))?
}

/// 全量覆盖落盘（revertRound / revertSingleFile 等轮次变少/修改场景）：JSONL 每行一轮。
fn save_session_changes_blocking(session_id: String, rounds: Vec<ChangeRoundData>) -> Result<(), String> {
    let dir = our_sessions_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create dir: {}", e))?;
    let path = dir.join(format!("{}-changes.json", session_id));
    let mut content = String::new();
    for r in &rounds {
        content.push_str(
            &serde_json::to_string(r).map_err(|e| format!("Failed to serialize: {}", e))?,
        );
        content.push('\n');
    }
    fs::write(&path, content).map_err(|e| format!("Failed to write: {}", e))
}

/// 追加单轮（captureChanges 的常规路径）：O(1) append 一行，不重写整份文件。
/// 前端用磁盘尾轮锚点保证只追加「磁盘之后的新轮」；revert 场景改走全量 save。
#[tauri::command]
pub async fn append_session_change(session_id: String, round: ChangeRoundData) -> Result<(), String> {
    tokio::task::spawn_blocking(move || append_session_change_blocking(session_id, round))
        .await
        .map_err(|e| format!("append_session_change task panicked: {}", e))?
}

fn append_session_change_blocking(session_id: String, round: ChangeRoundData) -> Result<(), String> {
    let dir = our_sessions_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create dir: {}", e))?;
    let path = dir.join(format!("{}-changes.json", session_id));
    let line = serde_json::to_string(&round).map_err(|e| format!("Failed to serialize: {}", e))?;
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open changes: {}", e))?;
    writeln!(file, "{line}").map_err(|e| format!("Failed to append: {}", e))
}

/// 每轮对话结束都会调用一次（takeSnapshot 记录撤回锚点），必须 async——同步版本
/// 曾在诊断黑匣子里被实锤为 Rust 主线程冻结的嫌疑对象：`find_session_jsonl_globally`
/// 遍历 `~/.aide/claude/projects/` 是同步磁盘 IO，杀软实时扫描 / 磁盘争抢时可能被拖到
/// 秒级甚至更久，堵在 Tauri 主线程上会连累所有后续命令排队（详见 CLAUDE.md「同步
/// command 禁止重 IO」）。同名兄弟 `session_last_event` 早已是 async，这两个是漏网之鱼。
#[tauri::command]
pub async fn session_jsonl_size(
    _workspace_state: State<'_, WorkspaceState>,
    session_id: String,
) -> Result<u64, String> {
    tokio::task::spawn_blocking(move || session_jsonl_size_blocking(session_id))
        .await
        .map_err(|e| format!("session_jsonl_size task panicked: {}", e))?
}

fn session_jsonl_size_blocking(session_id: String) -> Result<u64, String> {
    let Some(jsonl_path) = find_session_jsonl_globally(&session_id).into_iter().next() else {
        return Ok(0);
    };

    let metadata = fs::metadata(&jsonl_path)
        .map_err(|e| format!("Failed to read jsonl metadata: {}", e))?;

    Ok(metadata.len())
}

#[tauri::command]
pub async fn session_truncate_jsonl(
    _workspace_state: State<'_, WorkspaceState>,
    session_id: String,
    byte_pos: u64,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || session_truncate_jsonl_blocking(session_id, byte_pos))
        .await
        .map_err(|e| format!("session_truncate_jsonl task panicked: {}", e))?
}

fn session_truncate_jsonl_blocking(session_id: String, byte_pos: u64) -> Result<(), String> {
    let Some(jsonl_path) = find_session_jsonl_globally(&session_id).into_iter().next() else {
        return Ok(());
    };

    let file = fs::OpenOptions::new()
        .write(true)
        .open(&jsonl_path)
        .map_err(|e| format!("Failed to open jsonl: {}", e))?;

    file.set_len(byte_pos)
        .map_err(|e| format!("Failed to truncate jsonl: {}", e))?;

    Ok(())
}

/// List sessions for a specific workspace by its encoded key, without relying
/// on the current WorkspaceState. Used by the frontend to load sessions for
/// non-active (but expanded) workspaces (侧栏展开工作区 / 分屏布局恢复).
///
/// 同 `list_sessions`：扫目录 + 逐会话读 .jsonl/JSON 元数据是重同步 IO，必须
/// async + spawn_blocking，否则堵主线程（诊断黑匣子实锤过同类命令 `session_jsonl_size`
/// 堵死主线程 30s+，这个命令逻辑更重，是同一类风险，一并修）。
#[tauri::command]
pub async fn list_sessions_for_workspace(ws_key: String) -> Result<Vec<Session>, String> {
    tokio::task::spawn_blocking(move || list_sessions_for_workspace_blocking(ws_key))
        .await
        .map_err(|e| format!("list_sessions_for_workspace task panicked: {}", e))?
}

fn list_sessions_for_workspace_blocking(ws_key: String) -> Result<Vec<Session>, String> {
    let mut sessions: Vec<Session> = Vec::new();

    // 同 list_sessions_blocking：dot 归一匹配所有候选项目目录，合并扫描。
    for proj_dir in super::resolve_project_dirs(&claude_projects_dir(), &ws_key) {
        scan_project_jsonl_sessions(&proj_dir, &mut sessions)?;
    }

    // Second pass: scan ~/.aide/claude/sessions/ for sessions with metadata but no .jsonl
    let root = super::resolve_path_from_key(&ws_key).unwrap_or_default();
    let root_normalized = normalize_path_for_compare(&root);
    let sessions_dir = claude_sessions_dir();
    if sessions_dir.exists() && !root.is_empty() {
        if let Ok(read_dir) = fs::read_dir(&sessions_dir) {
            for entry in read_dir {
                let Ok(entry) = entry else { continue; };
                let path = entry.path();
                if path.extension().map(|e| e == "json").unwrap_or(false) {
                    let Ok(content) = fs::read_to_string(&path) else { continue; };
                    let Ok(v) = serde_json::from_str::<Value>(&content) else { continue; };

                    let session_cwd = v.get("cwd").and_then(|c| c.as_str()).unwrap_or("");
                    if normalize_path_for_compare(session_cwd) != root_normalized {
                        continue;
                    }

                    let session_id = v.get("sessionId").and_then(|s| s.as_str()).unwrap_or("");
                    if session_id.is_empty() {
                        continue;
                    }

                    if sessions.iter().any(|s| s.id == session_id) {
                        continue;
                    }

                    let name = v.get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("未命名")
                        .to_string();
                    let started_at = v.get("startedAt").and_then(|t| t.as_u64()).unwrap_or(0);
                    let display_name = our_session_name(&session_id).unwrap_or(name);

                    sessions.push(Session {
                        id: session_id.to_string(),
                        name: display_name,
                        timestamp: started_at,
                    });
                }
            }
        }
    }

    sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(sessions)
}

// ── Internal helpers ──

fn claude_session_meta(session_id: &str) -> Option<(String, u64)> {
    let dir = claude_sessions_dir();
    if !dir.exists() {
        return None;
    }
    let read_dir = fs::read_dir(&dir).ok()?;
    for entry in read_dir {
        let Ok(entry) = entry else { continue; };
        let path = entry.path();
        if path.extension().map(|e| e == "json").unwrap_or(false) {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(v) = serde_json::from_str::<Value>(&content) {
                    if v.get("sessionId").and_then(|s| s.as_str()) == Some(session_id) {
                        let name = v.get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or("未命名")
                            .to_string();
                        let started_at = v.get("startedAt")
                            .and_then(|t| t.as_u64())
                            .unwrap_or(0);
                        return Some((name, started_at));
                    }
                }
            }
        }
    }
    None
}

/// 取 jsonl 末条消息的文本（≤80 字）。仅供自动化运行摘要（RunRecord.summary）——
/// 运行终态时读本运行转录的尾行；会话列表已不展示末消息预览。
///
/// seek 到文件尾往回读末段找最后一个 `\n`：不整读大 .jsonl。窗口 64KB 起，
/// 末行超窗（窗口内无 `\n`）倍增扩大，最终整读兜底。
pub(crate) fn last_jsonl_message(jsonl_path: &std::path::Path) -> String {
    let file = match fs::File::open(jsonl_path) {
        Ok(f) => f,
        Err(_) => return String::new(),
    };
    let file_len = match file.metadata() {
        Ok(m) => m.len(),
        // 不可达：File::open 成功的句柄 metadata 必然成功（仅文件系统级异常才可能）
        Err(_) => return String::new(),
    };
    let mut window = 64 * 1024u64;
    loop {
        let read_len = file_len.min(window) as usize;
        let start = file_len - read_len as u64;
        let mut buf = vec![0u8; read_len];
        let mut f = &file;
        if f.seek(SeekFrom::Start(start)).is_err() || f.read_exact(&mut buf).is_err() {
            // 不可达：成功打开的常规文件 seek/read 不会失败（仅 IO 层异常才可能）
            return String::new();
        }
        if let Some(pos) = buf.iter().rposition(|&b| b == b'\n') {
            // 末行起点：文件末尾无 \n（EOF 半截行）时取最后一个 \n 之后；
            // 文件以 \n 结尾时取倒数第二个 \n 之后（末行 = 最后一个完整行）。
            let start = if pos + 1 < buf.len() {
                pos + 1
            } else {
                buf[..pos].iter().rposition(|&b| b == b'\n').map(|p| p + 1).unwrap_or(0)
            };
            // \r\n 对齐（sidecar parseLines 兼容），末行剥 \r
            let last_line = String::from_utf8_lossy(&buf[start..]).trim_end_matches('\r').to_string();
            let text = last_message_text(&last_line);
            if !text.is_empty() {
                return text;
            }
            // 末行解析失败 = 窗口截断了大行（行尾 \n 在窗内但行头在窗外）→ 扩大窗口重试
            if window >= file_len {
                return String::new();
            }
            window = (window * 2).min(file_len);
            continue;
        }
        if window >= file_len {
            // 整读仍无 \n：单行文件，整段即末行
            return last_message_text(&String::from_utf8_lossy(&buf).trim_end_matches('\r').to_string());
        }
        window = (window * 2).min(file_len);
    }
}

/// 从一行 JSON 提取消息文本（≤80 字）。纯函数便于单测。
fn last_message_text(line: &str) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(line) {
        if let Some(content_val) = v.get("message").and_then(|m| m.get("content")) {
            let text = if let Some(s) = content_val.as_str() {
                s.to_string()
            } else if let Some(arr) = content_val.as_array() {
                let texts: Vec<&str> = arr.iter()
                    .filter(|c| c.get("type").and_then(|t| t.as_str()) == Some("text"))
                    .filter_map(|c| c.get("text").and_then(|t| t.as_str()))
                    .collect();
                texts.join(" ")
            } else {
                String::new()
            };
            if !text.is_empty() {
                return text.chars().take(80).collect();
            }
        }
    }
    String::new()
}

/// Lightweight session discovery used during new-session polling.
///
/// Scans only `~/.aide/claude/sessions/` (small JSON metadata, no .jsonl reads) and
/// returns IDs of sessions whose `startedAt > since_ms` that belong to the
/// current workspace. Results are sorted newest-first so the caller can pick the
/// first ID that isn't already mapped to an active PTY.
#[tauri::command]
pub fn find_sessions_since(
    workspace_state: State<'_, WorkspaceState>,
    since_ms: u64,
) -> Result<Vec<String>, String> {
    let sessions_dir = claude_sessions_dir();
    if !sessions_dir.exists() {
        return Ok(Vec::new());
    }

    let root = project_root_for_commands(&workspace_state);
    let root_normalized = normalize_path_for_compare(&root.to_string_lossy());

    let read_dir = fs::read_dir(&sessions_dir)
        .map_err(|e| format!("Failed to read sessions dir: {}", e))?;

    let mut candidates: Vec<(String, u64)> = Vec::new();

    for entry in read_dir {
        let Ok(entry) = entry else { continue; };
        let path = entry.path();
        if !path.extension().map(|e| e == "json").unwrap_or(false) {
            continue;
        }

        let Ok(content) = fs::read_to_string(&path) else { continue; };
        let Ok(v) = serde_json::from_str::<Value>(&content) else { continue; };

        let started_at = v.get("startedAt").and_then(|t| t.as_u64()).unwrap_or(0);
        if started_at <= since_ms {
            continue;
        }

        let session_cwd = v.get("cwd").and_then(|c| c.as_str()).unwrap_or("");
        if normalize_path_for_compare(session_cwd) != root_normalized {
            continue;
        }

        let session_id = v.get("sessionId").and_then(|s| s.as_str()).unwrap_or("");
        if session_id.is_empty() {
            continue;
        }

        candidates.push((session_id.to_string(), started_at));
    }

    candidates.sort_by(|a, b| b.1.cmp(&a.1));
    Ok(candidates.into_iter().map(|(id, _)| id).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_session_writes_metadata_under_caller_supplied_id() {
        // 回归：create_session 不再自造 new_<ts> id，必须原样用调用方传入的
        // （真实）id 落盘——这个 id 就是终身 id，没有事后改名这一步。
        let id = "test-fixed-id-aa11bb22".to_string();
        let path = our_sessions_dir().join(format!("{}.json", id));
        let _ = fs::remove_file(&path); // 防止上次失败留下的残留

        let session = create_session(id.clone(), "测试会话".to_string()).unwrap();
        assert_eq!(session.id, id);
        assert_eq!(session.name, "测试会话");

        let content = fs::read_to_string(&path).expect("metadata file should exist");
        let v: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(v.get("id").and_then(|x| x.as_str()), Some(id.as_str()));
        assert_eq!(v.get("name").and_then(|x| x.as_str()), Some("测试会话"));

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn create_session_marks_name_source_auto() {
        // 自动命名的判定依据：新建的会话名字是默认名（可覆盖），必须标 nameSource=auto。
        let id = "test-namesource-create-aa11bb22".to_string();
        let path = our_sessions_dir().join(format!("{}.json", id));
        let _ = fs::remove_file(&path);

        create_session(id.clone(), "新会话 12:00:00".to_string()).unwrap();
        let content = fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(v.get("nameSource").and_then(|x| x.as_str()), Some("auto"));

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn rename_session_marks_name_source_manual() {
        // 用户手动改过的名字必须标 manual——自动标题生成回来也不能覆盖它。
        let id = "test-namesource-rename-aa11bb22".to_string();
        let path = our_sessions_dir().join(format!("{}.json", id));
        let _ = fs::remove_file(&path);

        create_session(id.clone(), "新会话 12:00:00".to_string()).unwrap();
        rename_session(id.clone(), "我自己起的名".to_string()).unwrap();
        let content = fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(v.get("name").and_then(|x| x.as_str()), Some("我自己起的名"));
        assert_eq!(v.get("nameSource").and_then(|x| x.as_str()), Some("manual"));

        let _ = fs::remove_file(&path);
    }

    #[tokio::test]
    async fn auto_rename_adopts_when_never_named_manually() {
        let id = "test-autorename-adopt-aa11bb22".to_string();
        let path = our_sessions_dir().join(format!("{}.json", id));
        let _ = fs::remove_file(&path);

        create_session(id.clone(), "新会话 12:00:00".to_string()).unwrap();
        let adopted = auto_rename_session(id.clone(), "修复登录 Bug".to_string())
            .await
            .unwrap();
        assert!(adopted, "auto 命名的会话应采纳自动标题");

        let content = fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(v.get("name").and_then(|x| x.as_str()), Some("修复登录 Bug"));
        assert_eq!(v.get("nameSource").and_then(|x| x.as_str()), Some("auto"));

        let _ = fs::remove_file(&path);
    }

    #[tokio::test]
    async fn auto_rename_refused_after_manual_rename() {
        // 竞态防线：标题生成要几秒，期间用户可能已手动改名——manual 一律拒写。
        let id = "test-autorename-refuse-aa11bb22".to_string();
        let path = our_sessions_dir().join(format!("{}.json", id));
        let _ = fs::remove_file(&path);

        create_session(id.clone(), "新会话 12:00:00".to_string()).unwrap();
        rename_session(id.clone(), "我自己起的名".to_string()).unwrap();
        let adopted = auto_rename_session(id.clone(), "修复登录 Bug".to_string())
            .await
            .unwrap();
        assert!(!adopted, "manual 命名的会话必须拒绝自动标题");

        let content = fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(v.get("name").and_then(|x| x.as_str()), Some("我自己起的名"));

        let _ = fs::remove_file(&path);
    }

    #[tokio::test]
    async fn auto_rename_treats_missing_name_source_as_auto() {
        // 旧数据没有 nameSource 字段——视为 auto（否则老会话永远拿不到自动标题）。
        let id = "test-autorename-legacy-aa11bb22".to_string();
        let path = our_sessions_dir().join(format!("{}.json", id));
        let _ = fs::remove_file(&path);

        let dir = our_sessions_dir();
        fs::create_dir_all(&dir).unwrap();
        fs::write(&path, serde_json::json!({ "id": id, "name": "旧会话" }).to_string()).unwrap();

        let adopted = auto_rename_session(id.clone(), "旧会话的新标题".to_string())
            .await
            .unwrap();
        assert!(adopted, "缺 nameSource 的旧数据应视为 auto");

        let _ = fs::remove_file(&path);
    }

    #[tokio::test]
    async fn auto_rename_creates_metadata_when_missing() {
        // 元数据文件还没建（极端时序：标题先于 create_session 到达）也能落盘。
        let id = "test-autorename-create-aa11bb22".to_string();
        let path = our_sessions_dir().join(format!("{}.json", id));
        let _ = fs::remove_file(&path);

        let adopted = auto_rename_session(id.clone(), "直接生成的标题".to_string())
            .await
            .unwrap();
        assert!(adopted);
        let content = fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(v.get("name").and_then(|x| x.as_str()), Some("直接生成的标题"));

        let _ = fs::remove_file(&path);
    }

    #[tokio::test]
    async fn session_model_roundtrip_and_preserves_other_fields() {
        // 回归：模型选择记进会话元数据并能读回；merge 写不能冲掉 name 等既有字段。
        let id = "test-model-aa11bb22".to_string();
        let path = our_sessions_dir().join(format!("{}.json", id));
        let _ = fs::remove_file(&path);

        create_session(id.clone(), "模型会话".to_string()).unwrap();
        assert_eq!(session_model(id.clone()).await.unwrap(), None);

        set_session_model(id.clone(), "sonnet".to_string()).await.unwrap();
        assert_eq!(session_model(id.clone()).await.unwrap(), Some("sonnet".to_string()));

        // name 字段必须还活着（merge 而非覆盖）
        let content = fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(v.get("name").and_then(|x| x.as_str()), Some("模型会话"));

        // 覆盖写 + 清空（清空后读回 None）
        set_session_model(id.clone(), "opus".to_string()).await.unwrap();
        assert_eq!(session_model(id.clone()).await.unwrap(), Some("opus".to_string()));
        set_session_model(id.clone(), String::new()).await.unwrap();
        assert_eq!(session_model(id.clone()).await.unwrap(), None);

        let _ = fs::remove_file(&path);
    }

    #[tokio::test]
    async fn session_model_returns_none_for_unknown_session() {
        // 没记过的会话 → None，前端据此走默认选择逻辑
        assert_eq!(
            session_model("test-model-never-exists-aa11bb22".to_string())
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn session_provider_roundtrip_and_preserves_other_fields() {
        // 回归：供应商绑定记进会话元数据并能读回；merge 写不能冲掉 name/model 等既有字段。
        let id = "test-provider-aa11bb22".to_string();
        let path = our_sessions_dir().join(format!("{}.json", id));
        let _ = fs::remove_file(&path);

        create_session(id.clone(), "供应商会话".to_string()).unwrap();
        assert_eq!(session_provider(id.clone()).await.unwrap(), None);

        set_session_provider(id.clone(), "p_abc".to_string()).await.unwrap();
        assert_eq!(session_provider(id.clone()).await.unwrap(), Some("p_abc".to_string()));

        // name 字段必须还活着（merge 而非覆盖）
        let content = fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(v.get("name").and_then(|x| x.as_str()), Some("供应商会话"));

        // 覆盖写 + 清空（清空后读回 None）
        set_session_provider(id.clone(), "p_def".to_string()).await.unwrap();
        assert_eq!(session_provider(id.clone()).await.unwrap(), Some("p_def".to_string()));
        set_session_provider(id.clone(), String::new()).await.unwrap();
        assert_eq!(session_provider(id.clone()).await.unwrap(), None);

        let _ = fs::remove_file(&path);
    }

    #[tokio::test]
    async fn session_provider_returns_none_for_unknown_session() {
        // 没记过的会话 → None，前端据此走全局激活供应商回落
        assert_eq!(
            session_provider("test-provider-never-exists-aa11bb22".to_string())
                .await
                .unwrap(),
            None
        );
    }

    // 回归：真实会话记录里，Skill 注入(isMeta)、中断占位符
    // (interruptedMessageId)、压缩摘要(isCompactSummary)、后台任务通知
    // (origin.kind != "human") 都以 role:"user" 落盘，但都不是人类真正打的字——
    // 曾经被 load_messages 原样当用户消息渲染，在 UI 上显示成"用户说的话"。
    #[test]
    fn synthetic_user_entries_are_detected() {
        assert!(is_synthetic_user_entry(&serde_json::json!({ "isMeta": true })));
        assert!(is_synthetic_user_entry(&serde_json::json!({ "interruptedMessageId": "msg_1" })));
        assert!(is_synthetic_user_entry(&serde_json::json!({ "isCompactSummary": true })));
        assert!(is_synthetic_user_entry(&serde_json::json!({ "origin": { "kind": "task-notification" } })));
    }

    #[test]
    fn genuine_human_entries_are_not_filtered() {
        // 新版 SDK：显式标注 origin.kind == "human"
        assert!(!is_synthetic_user_entry(&serde_json::json!({ "origin": { "kind": "human" } })));
        // 旧版 transcript：没有 origin 字段，也没有任何合成标记——必须保留，
        // 否则会把老会话里的真实提问全部隐藏掉。
        assert!(!is_synthetic_user_entry(&serde_json::json!({})));
    }

    // 回归：重启/切回会话后，历史里的工具调用（Bash/Edit 等）之前被整段丢弃，只剩
    // 纯文字——根因是旧实现只保留 content 数组里 type=="text" 的 block。这组测试
    // 验证 parse_transcript_lines 按原始顺序重建 text/tool_call 两种块，且正确把
    // 稍后一行 user 消息里的 tool_result 回填进对应的 tool_call。
    mod parse_transcript_lines_tests {
        use super::*;

        fn line(v: serde_json::Value) -> String {
            v.to_string()
        }

        #[test]
        fn plain_text_messages_still_work_unchanged() {
            let lines = vec![
                line(serde_json::json!({
                    "type": "user",
                    "message": { "content": "你好" },
                })),
                line(serde_json::json!({
                    "type": "assistant",
                    "message": { "content": [{ "type": "text", "text": "你好，有什么可以帮你？" }] },
                })),
            ];
            let messages = parse_transcript_lines(&lines);
            assert_eq!(messages.len(), 2);
            assert_eq!(messages[0].role, "user");
            assert!(matches!(&messages[0].blocks[..], [HistoryBlock::Text { text }] if text == "你好"));
            assert_eq!(messages[1].role, "claude");
            assert!(
                matches!(&messages[1].blocks[..], [HistoryBlock::Text { text }] if text == "你好，有什么可以帮你？")
            );
        }

        #[test]
        fn tool_use_is_reconstructed_and_filled_in_by_a_later_tool_result_line() {
            let lines = vec![
                line(serde_json::json!({
                    "type": "assistant",
                    "message": { "content": [
                        { "type": "text", "text": "我看一下这个文件" },
                        { "type": "tool_use", "id": "t1", "name": "Read", "input": { "file_path": "a.ts" } },
                    ] },
                })),
                // tool_result 落在稍后一行的 user 消息里，且这一行没有真人文字，
                // 不该单独变成一条用户气泡。
                line(serde_json::json!({
                    "type": "user",
                    "message": { "content": [
                        { "type": "tool_result", "tool_use_id": "t1", "content": "文件内容……", "is_error": false },
                    ] },
                })),
            ];
            let messages = parse_transcript_lines(&lines);
            assert_eq!(messages.len(), 1, "纯 tool_result 的 user 行不应该单独变成一条消息");
            assert_eq!(messages[0].blocks.len(), 2);
            assert!(matches!(&messages[0].blocks[0], HistoryBlock::Text { text } if text == "我看一下这个文件"));
            match &messages[0].blocks[1] {
                HistoryBlock::ToolCall { id, name, result, is_error, .. } => {
                    assert_eq!(id, "t1");
                    assert_eq!(name, "Read");
                    assert_eq!(result.as_deref(), Some("文件内容……"));
                    assert_eq!(*is_error, Some(false));
                }
                other => panic!("expected ToolCall block, got {other:?}"),
            }
        }

        #[test]
        fn tool_use_without_a_matching_tool_result_keeps_result_as_none() {
            // 会话在工具还没返回结果时就中断/崩溃——历史里应该显示"没有结果"，
            // 而不是凭空编一个，也不该因为找不到结果就整段丢弃。
            let lines = vec![line(serde_json::json!({
                "type": "assistant",
                "message": { "content": [
                    { "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "ls" } },
                ] },
            }))];
            let messages = parse_transcript_lines(&lines);
            assert_eq!(messages.len(), 1);
            match &messages[0].blocks[0] {
                HistoryBlock::ToolCall { result, is_error, .. } => {
                    assert_eq!(*result, None);
                    assert_eq!(*is_error, None);
                }
                other => panic!("expected ToolCall block, got {other:?}"),
            }
        }

        #[test]
        fn subagent_tool_calls_are_dropped_not_reconstructed() {
            // 明确不在这次修复范围内：Agent/Task 子代理调用维持原有降级行为——
            // 整段跳过，不出现在历史里（分步进度 Claude CLI 从不落盘，做了也补不全）。
            for tool_name in ["Agent", "Task"] {
                let lines = vec![line(serde_json::json!({
                    "type": "assistant",
                    "message": { "content": [
                        { "type": "tool_use", "id": "a1", "name": tool_name, "input": { "subagent_type": "general-purpose" } },
                    ] },
                }))];
                let messages = parse_transcript_lines(&lines);
                assert!(messages.is_empty(), "{tool_name} 应该被整段丢弃");
            }
        }

        #[test]
        fn subagent_call_is_dropped_but_sibling_text_in_the_same_message_is_kept() {
            let lines = vec![line(serde_json::json!({
                "type": "assistant",
                "message": { "content": [
                    { "type": "text", "text": "我先看看情况" },
                    { "type": "tool_use", "id": "a1", "name": "Agent", "input": { "subagent_type": "general-purpose" } },
                ] },
            }))];
            let messages = parse_transcript_lines(&lines);
            assert_eq!(messages.len(), 1);
            assert_eq!(messages[0].blocks.len(), 1);
            assert!(matches!(&messages[0].blocks[0], HistoryBlock::Text { text } if text == "我先看看情况"));
        }

        #[test]
        fn synthetic_user_entries_are_still_skipped() {
            let lines = vec![line(serde_json::json!({
                "type": "user",
                "isMeta": true,
                "message": { "content": "这是 Skill 注入，不是人打的" },
            }))];
            assert!(parse_transcript_lines(&lines).is_empty());
        }

        #[test]
        fn consecutive_assistant_lines_merge_into_one_message() {
            // 同一回合的 assistant 在 transcript 里逐 chunk 各占一行（一段文本、
            // 一次工具调用各一行），中间还穿插 tool_result 的 user 行（会被跳过）。
            // 这些行必须合并回一条消息，否则前端的消息内工具分组（ToolCallGroup）
            // 会把一个回合的连续调用拆成 N 个「1 次工具调用」的组。
            let lines = vec![
                line(serde_json::json!({
                    "type": "user",
                    "message": { "content": "帮我看看" },
                })),
                line(serde_json::json!({
                    "type": "assistant",
                    "message": { "content": [{ "type": "text", "text": "先读文件。" }] },
                })),
                line(serde_json::json!({
                    "type": "assistant",
                    "message": { "content": [{ "type": "tool_use", "id": "t1", "name": "Read", "input": { "file_path": "a.java" } }] },
                })),
                line(serde_json::json!({
                    "type": "user",
                    "message": { "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "ok" }] },
                })),
                line(serde_json::json!({
                    "type": "assistant",
                    "message": { "content": [{ "type": "tool_use", "id": "t2", "name": "Read", "input": { "file_path": "b.java" } }] },
                })),
                line(serde_json::json!({
                    "type": "assistant",
                    "message": { "content": [{ "type": "text", "text": "结论。" }] },
                })),
                line(serde_json::json!({
                    "type": "user",
                    "message": { "content": "下一个问题" },
                })),
                line(serde_json::json!({
                    "type": "assistant",
                    "message": { "content": [{ "type": "text", "text": "好的。" }] },
                })),
            ];

            let messages = parse_transcript_lines(&lines);

            let roles: Vec<&str> = messages.iter().map(|m| m.role.as_str()).collect();
            assert_eq!(roles, vec!["user", "claude", "user", "claude"], "真实 user 行仍然隔断回合");
            // 第一回合的 4 个 chunk（text + tool_use + tool_use + text）合并进一条消息
            assert_eq!(messages[1].blocks.len(), 4);
            // tool_result 回填不受合并影响
            match &messages[1].blocks[1] {
                HistoryBlock::ToolCall { id, result, .. } => {
                    assert_eq!(id, "t1");
                    assert_eq!(result.as_deref(), Some("ok"));
                }
                other => panic!("expected tool_call, got {other:?}"),
            }
        }
    }

    /// 字节游标分页测试：从文件尾/任意字节位置往前取一页，页首裁到真实 user 行。
    /// 用临时 .jsonl（仓库无 tempfile crate，沿用 std::env::temp_dir + pid 惯例）。
    mod read_page_backwards_tests {
        use super::*;

        fn line(v: serde_json::Value) -> String {
            v.to_string()
        }

        fn temp_jsonl(name: &str, content: &str) -> std::path::PathBuf {
            let p = std::env::temp_dir().join(format!("aide-page-{}-{}", name, std::process::id()));
            let _ = std::fs::remove_file(&p);
            std::fs::write(&p, content).unwrap();
            p
        }

        fn page_from_file(
            p: &std::path::Path,
            offset: Option<u64>,
            limit_bytes: u32,
        ) -> LoadMessagesResult {
            let file = fs::File::open(p).unwrap();
            let file_len = file.metadata().unwrap().len();
            read_page_backwards(&file, file_len, offset, limit_bytes).unwrap()
        }

        /// 字节预算语义下的「全量页」预算（10MB > 任何测试文件大小）。
        const BIG: u32 = 10 * 1024 * 1024;
        /// 「尾部 n 行」的字节预算：页 = 累计字节 ≤ 预算的消息（第 n+1 行加入会超才截断，
        /// 故预算 = n 行字节和恰好收下这 n 行；单行超预算时最新 1 条保底）。
        fn budget_tail_lines(lines: &[String], n: usize) -> u32 {
            lines.iter().rev().take(n).map(|l| l.len()).sum::<usize>() as u32
        }
        /// 行区间 [start, end) 的字节预算（同理）。
        fn budget_line_range(lines: &[String], start: usize, end: usize) -> u32 {
            lines[start..end].iter().map(|l| l.len()).sum::<usize>() as u32
        }

        /// 标准会话：8 行 → 6 条消息（L4 是 tool_result-only 行不成为消息，
        /// L3+L5 连续 assistant 行合并成一条）。
        fn standard_lines() -> Vec<String> {
            vec![
                line(serde_json::json!({ "type": "user", "message": { "content": "你好" } })),
                line(serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "你好,有什么可以帮你?" }] } })),
                line(serde_json::json!({ "type": "user", "message": { "content": "帮我看看这个文件" } })),
                line(serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use", "id": "t1", "name": "Read", "input": { "file_path": "a.ts" } }] } })),
                line(serde_json::json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "文件内容……", "is_error": false }] } })),
                line(serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "文件内容如下" }] } })),
                line(serde_json::json!({ "type": "user", "message": { "content": "谢谢" } })),
                line(serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "不客气" }] } })),
            ]
        }

        #[test]
        fn empty_file_returns_empty_page() {
            let p = temp_jsonl("empty", "");
            let result = page_from_file(&p, None, BIG);
            assert!(result.messages.is_empty());
            assert_eq!(result.next_offset_bytes, 0);
        }

        #[test]
        fn out_of_range_cursor_clamps_to_file_end() {
            let p = temp_jsonl("clamp", &standard_lines().join("\n"));
            let file = fs::File::open(&p).unwrap();
            let file_len = file.metadata().unwrap().len();
            // 越界游标（revertRound 截断后旧游标失效）→ clamp 到文件尾 → 与 offset=None 相同
            let clamped = read_page_backwards(&file, file_len, Some(file_len + 1000), BIG).unwrap();
            let tail = read_page_backwards(&file, file_len, None, BIG).unwrap();
            assert_eq!(clamped.messages.len(), tail.messages.len());
            assert_eq!(clamped.next_offset_bytes, tail.next_offset_bytes);
        }

        #[test]
        fn end_offset_bytes_reports_exclusive_page_end() {
            // 页级回收（前端 recycle）按 (endOffset, end-start) 确定性重取同一页——
            // end_offset_bytes 必须恒等于「本次读取的排他末尾」：尾页=file_len，
            // 中间页=传入 offset，clamp 后=file_len，空文件=0。
            let lines = standard_lines();
            let p = temp_jsonl("endoff", &(lines.join("\n") + "\n"));
            let file = fs::File::open(&p).unwrap();
            let file_len = file.metadata().unwrap().len();

            // 尾页：offset=None → end=file_len
            let tail = read_page_backwards(&file, file_len, None, BIG).unwrap();
            assert_eq!(tail.end_offset_bytes, file_len);

            // 中间页：offset=某页首 → end=该 offset（且 next_offset < end，页非空）
            let mid = read_page_backwards(&file, file_len, Some(tail.next_offset_bytes.max(1)), BIG).unwrap();
            assert_eq!(mid.end_offset_bytes, tail.next_offset_bytes.max(1));

            // clamp：越界 → end=file_len
            let clamped = read_page_backwards(&file, file_len, Some(file_len + 1000), BIG).unwrap();
            assert_eq!(clamped.end_offset_bytes, file_len);

            // 空文件：file_len=0 → end=0
            let empty = temp_jsonl("endoff-empty", "");
            let ef = fs::File::open(&empty).unwrap();
            let r = read_page_backwards(&ef, 0, None, BIG).unwrap();
            assert_eq!(r.end_offset_bytes, 0);

            // 整读路径：end=file_len
            let full = read_all_messages(fs::File::open(&p).unwrap(), file_len).unwrap();
            assert_eq!(full.end_offset_bytes, file_len);
        }

        #[test]
        fn cursor_mid_line_discards_that_line() {
            let lines = standard_lines();
            let p = temp_jsonl("midline", &(lines.join("\n") + "\n"));
            // 游标落在第 2 行（assistant）中间 → 该行丢弃，页 = 第 1 行
            let mid = (lines[0].len() + lines[1].len() / 2) as u64;
            let result = page_from_file(&p, Some(mid), BIG);
            assert_eq!(result.messages.len(), 1);
            assert_eq!(result.messages[0].role, "user");
            assert_eq!(result.next_offset_bytes, 0);
        }

        #[test]
        fn eof_half_line_is_skipped() {
            let mut content = standard_lines().join("\n") + "\n";
            // 文件末尾追加无 \n 的半截行（CLI 崩溃残留）→ 跳过
            content.push_str("{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"半截");
            let p = temp_jsonl("eofhalf", &content);
            let result = page_from_file(&p, None, BIG);
            assert_eq!(result.messages.len(), 6, "半截行被丢弃，页 = 全部完整行");
            assert_eq!(result.messages[0].role, "user");
            assert_eq!(result.next_offset_bytes, 0);
        }

        #[test]
        fn page_start_must_be_real_user_line() {
            // 防御场景：文件以 assistant 开头且预算内无 user 行——页首 user 裁剪会
            // 裁光 → 空页会掐死 hasMore（预览无法继续翻页）。修复后回退保留预算内
            // 全部（页首可非 user），游标指向文件头（0 = 没有更早可读了）
            let lines = vec![
                line(serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "a" }] } })),
                line(serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "b" }] } })),
            ];
            let p = temp_jsonl("nostr", &(lines.join("\n") + "\n"));
            let result = page_from_file(&p, None, BIG);
            // 连续 assistant 行合并成 1 条消息；预算内无 user → 保留全部而非空页
            assert_eq!(result.messages.len(), 1, "预算内无 user：保留全部而非空页");
            assert_eq!(result.next_offset_bytes, 0, "已到文件头，无更早页");
        }

        #[test]
        fn byte_budget_trims_oldest_messages() {
            let lines = standard_lines();
            let p = temp_jsonl("limit", &(lines.join("\n") + "\n"));
            // 预算 = 尾部 2 行字节和 − 1 → 页 = 最新 2 条：[user 谢谢, claude 不客气]
            let result = page_from_file(&p, None, budget_tail_lines(&lines, 2));
            assert_eq!(result.messages.len(), 2);
            assert_eq!(result.messages[0].role, "user");
            assert!(matches!(&result.messages[0].blocks[..], [HistoryBlock::Text { text }] if text == "谢谢"));
            assert_eq!(result.messages[1].role, "claude");
            // 页首 = 第 7 行（谢谢）起始字节
            let expected = lines[..6].iter().map(|l| l.len() + 1).sum::<usize>() as u64;
            assert_eq!(result.next_offset_bytes, expected);
        }

        #[test]
        fn single_oversized_message_fills_page_alone() {
            // 单条超大消息（> 预算）：最新 1 条兜底返回，不因超预算被截成空页
            let big_text = "y".repeat(5_000);
            let lines = vec![
                line(serde_json::json!({ "type": "user", "message": { "content": "q0" } })),
                line(serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": big_text }] } })),
                line(serde_json::json!({ "type": "user", "message": { "content": "q1" } })),
            ];
            let p = temp_jsonl("oversized", &(lines.join("\n") + "\n"));
            // 预算 100 字节 << 大行（~5KB）：页 = 最新 1 条（q1 user 行保底）
            let result = page_from_file(&p, None, 100);
            assert_eq!(result.messages.len(), 1);
            assert_eq!(result.messages[0].role, "user");
            assert!(matches!(&result.messages[0].blocks[..], [HistoryBlock::Text { text }] if text == "q1"));
            assert!(result.next_offset_bytes > 0, "大行还在更早处");
        }

        #[test]
        fn budget_without_user_line_keeps_page_and_cursor() {
            // 长会话尾部工具轮密集：预算内没有真实 user 提问行（全是 assistant）。
            // 页首裁到 user 会裁光 → 空页 + nextOffset=0 → 前端「无法继续往上翻」。
            // 修复：回退保留预算内全部（页首可非 user），游标继续往前。
            let big_text = "z".repeat(3_000); // assistant 大行 ~3KB
            let lines = vec![
                line(serde_json::json!({ "type": "user", "message": { "content": "q0" } })),
                line(serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": big_text }] } })),
                line(serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "ls" } }] } })),
                line(serde_json::json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "out", "is_error": false }] } })),
                line(serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "ok" }] } })),
            ];
            let p = temp_jsonl("nouser", &(lines.join("\n") + "\n"));
            // 预算 100B：尾部累计仅够 1-2 条（都是 assistant 行），预算内无 user →
            // 页非空（回退保留）+ nextOffset 继续（>0，更早的 q0 还在）
            let result = page_from_file(&p, None, 100);
            assert!(!result.messages.is_empty(), "预算内无 user 时不得返回空页");
            assert!(result.next_offset_bytes > 0, "游标必须继续（更早的 user 还在）");
            // 继续取下一页 → 最终取回全部（含 q0 回合），无死循环
            let mut all: Vec<String> = Vec::new();
            let mut offset: Option<u64> = Some(result.next_offset_bytes);
            all.extend(result.messages.iter().map(|m| m.role.clone()));
            let mut guard = 0;
            while let Some(off) = offset {
                let page = page_from_file(&p, Some(off), 100);
                all.extend(page.messages.iter().map(|m| m.role.clone()));
                offset = if page.next_offset_bytes == 0 { None } else { Some(page.next_offset_bytes) };
                guard += 1;
                assert!(guard < 10, "游标链死循环");
            }
            assert!(all.contains(&"user".to_string()), "q0 回合最终被取回");
        }

        #[test]
        fn tool_result_in_same_collected_range_fills_in() {
            // 页内 tool_use 与 tool_result 落在不同行（tool_result-only user 行不成为
            // 消息）但同一收集范围 → result 正确回填。真正的「跨页缺失」（result 行在
            // 更早的未读块，>1MB 分块场景）由 parse_transcript_lines 的
            // tool_use_without_a_matching_tool_result 语义覆盖——表只建自收集行。
            let lines = vec![
                line(serde_json::json!({ "type": "user", "message": { "content": "q0" } })),
                line(serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "a" }] } })),
                line(serde_json::json!({ "type": "user", "message": { "content": "q1" } })),
                line(serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "ls" } }] } })),
                line(serde_json::json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "out", "is_error": false }] } })),
                line(serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "b" }] } })),
                line(serde_json::json!({ "type": "user", "message": { "content": "q2" } })),
                line(serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "ok" }] } })),
            ];
            let p = temp_jsonl("samepage", &(lines.join("\n") + "\n"));
            // 页1 = 最新 2 条：[user q2, claude ok]（预算 = 尾部 2 行字节和 − 1）
            let page1 = page_from_file(&p, None, budget_tail_lines(&lines, 2));
            assert_eq!(page1.messages.len(), 2);
            // 页2 = [q1 回合]（行 2..6，含 tool_result 行），t1 的 tool_use 与 result
            // 同页收集 → 回填成功
            let page2 = page_from_file(&p, Some(page1.next_offset_bytes), budget_line_range(&lines, 2, 6));
            assert_eq!(page2.messages.len(), 2);
            assert_eq!(page2.messages[0].role, "user");
            match &page2.messages[1].blocks[0] {
                HistoryBlock::ToolCall { id, result, .. } => {
                    assert_eq!(id, "t1");
                    assert_eq!(result.as_deref(), Some("out"));
                }
                other => panic!("expected ToolCall, got {other:?}"),
            }
        }

        #[test]
        fn oversized_line_spans_chunks() {
            // 1.2MB 单行跨 1MB 读块边界：往回分块读必须跨块拼接出完整行
            let big_text = "x".repeat(1_200_000);
            let lines = vec![
                line(serde_json::json!({ "type": "user", "message": { "content": "q1" } })),
                line(serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": big_text }] } })),
                line(serde_json::json!({ "type": "user", "message": { "content": "q2" } })),
                line(serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "ok" }] } })),
            ];
            let p = temp_jsonl("bigline", &(lines.join("\n") + "\n"));
            // 页1 = 最新 2 条（预算 = 尾部 2 行字节和 − 1；大行后半在块内是半截，被跳过，
            // 不影响页1）
            let page1 = page_from_file(&p, None, budget_tail_lines(&lines, 2));
            assert_eq!(page1.messages.len(), 2);
            // 页2 = 更早 2 条，含 1.2MB 大行（跨块拼接完整；BIG 预算覆盖大行）
            let page2 = page_from_file(&p, Some(page1.next_offset_bytes), BIG);
            assert_eq!(page2.messages.len(), 2);
            match &page2.messages[1].blocks[0] {
                HistoryBlock::Text { text } => assert_eq!(text.len(), 1_200_000),
                other => panic!("expected Text, got {other:?}"),
            }
        }

        #[test]
        fn no_pagination_equals_full_read() {
            let lines = standard_lines();
            let p = temp_jsonl("fullread", &(lines.join("\n") + "\n"));
            let file = fs::File::open(&p).unwrap();
            let file_len = file.metadata().unwrap().len();
            let result = read_all_messages(file, file_len).unwrap();
            assert_eq!(result.next_offset_bytes, 0);
            assert_eq!(result.end_offset_bytes, file_len);
            let expected = parse_transcript_lines(&lines);
            assert_eq!(result.messages.len(), expected.len());
            assert_eq!(result.messages[0].role, expected[0].role);
            assert_eq!(result.messages[5].role, expected[5].role);
        }

        #[test]
        fn tail_page_returns_last_two_messages() {
            let lines = standard_lines();
            let p = temp_jsonl("tail", &(lines.join("\n") + "\n"));
            let result = page_from_file(&p, None, budget_tail_lines(&lines, 2));
            assert_eq!(result.messages.len(), 2);
            assert_eq!(result.messages[0].role, "user");
            assert_eq!(result.messages[1].role, "claude");
            assert!(matches!(&result.messages[0].blocks[..], [HistoryBlock::Text { text }] if text == "谢谢"));
        }

        #[test]
        fn multi_page_roundtrip_no_dup_no_gap() {
            let p = temp_jsonl("roundtrip", &(standard_lines().join("\n") + "\n"));
            let mut all: Vec<String> = Vec::new();
            let mut offset: Option<u64> = None;
            loop {
                let page = page_from_file(&p, offset, 400);
                for m in &page.messages {
                    all.push(m.role.clone());
                }
                if page.next_offset_bytes == 0 {
                    break;
                }
                offset = Some(page.next_offset_bytes);
            }
            // 6 条消息，游标链无重复无遗漏（每页 ≤ 400 字节，页边界按字节而非条数）
            assert_eq!(all, vec!["user", "claude", "user", "claude", "user", "claude"]);
        }

        #[test]
        fn truncated_file_clamps_stale_cursor() {
            let lines = standard_lines();
            let p = temp_jsonl("truncate", &(lines.join("\n") + "\n"));
            // 先取尾部页（预算 = 尾部 2 行字节和 − 1 = 2 条），拿到游标
            let page1 = page_from_file(&p, None, budget_tail_lines(&lines, 2));
            assert_eq!(page1.messages.len(), 2);
            assert!(page1.next_offset_bytes > 0);
            // 模拟 revertRound 截断：文件缩短到第 4 行起始（截掉后半）。
            // 不用 set_len（Windows 杀软实时扫描会报 PermissionDenied），全量重写等效。
            let truncated = lines[..3].join("\n") + "\n";
            std::fs::write(&p, truncated).unwrap();
            // 旧游标 > 新文件末尾 → clamp 到尾部页（新文件的尾部）。
            // 新文件尾部是 [L1 assistant, L2 user]，预算页首 L1 非 user（截断落在回合
            // 中间）→ 从首条裁到页首 user，返回 [L2] 单条；游标指向 L2 起始（>0）。
            let result = page_from_file(&p, Some(page1.next_offset_bytes), budget_tail_lines(&lines[..3], 2));
            assert_eq!(result.messages.len(), 1);
            assert_eq!(result.messages[0].role, "user");
            assert!(matches!(&result.messages[0].blocks[..], [HistoryBlock::Text { text }] if text == "帮我看看这个文件"));
            assert!(result.next_offset_bytes > 0, "更早页 [你好] 还在");
            // 游标链：再取一页（BIG = 剩余全量）= [L0 user, L1 assistant]，到文件头
            let final_page = page_from_file(&p, Some(result.next_offset_bytes), BIG);
            assert_eq!(final_page.messages.len(), 2);
            assert_eq!(final_page.messages[0].role, "user");
            assert_eq!(final_page.next_offset_bytes, 0);
        }

        // ── last_jsonl_message seek 优化（末段反向读 + 纯函数提取）──

        #[test]
        fn last_message_extracts_string_content() {
            let line = line(serde_json::json!({ "type": "assistant", "message": { "content": "你好" } }));
            assert_eq!(last_message_text(&line), "你好");
        }

        #[test]
        fn last_message_joins_text_blocks_skipping_non_text() {
            let line = line(serde_json::json!({
                "type": "assistant",
                "message": { "content": [
                    { "type": "text", "text": "a" },
                    { "type": "tool_use", "id": "t1", "name": "Bash" },
                    { "type": "text", "text": "b" },
                ] },
            }));
            assert_eq!(last_message_text(&line), "a b");
        }

        #[test]
        fn last_message_truncates_to_80_chars() {
            let line = line(serde_json::json!({ "type": "assistant", "message": { "content": "x".repeat(200) } }));
            assert_eq!(last_message_text(&line).chars().count(), 80);
        }

        #[test]
        fn last_message_invalid_line_returns_empty() {
            assert_eq!(last_message_text("not json"), "");
        }

        #[test]
        fn last_jsonl_seek_reads_last_line_without_full_scan() {
            let lines = vec![
                line(serde_json::json!({ "type": "user", "message": { "content": "第一轮" } })),
                line(serde_json::json!({ "type": "assistant", "message": { "content": "最后一轮" } })),
            ];
            let p = temp_jsonl("lastmsg", &(lines.join("\n") + "\n"));
            assert_eq!(last_jsonl_message(&p), "最后一轮");
        }

        #[test]
        fn last_jsonl_eof_half_line_returns_empty() {
            // EOF 半截行（无 \n 结尾）：末段取到半截 JSON → 解析失败 → 空（与原整读行为一致）
            let mut content = standard_lines().join("\n") + "\n";
            content.push_str("{\"type\":\"assistant\",\"message\":{\"content\":\"半截");
            let p = temp_jsonl("lasthalf", &content);
            assert_eq!(last_jsonl_message(&p), "");
        }

        #[test]
        fn last_jsonl_oversized_line_expands_window() {
            // 70KB 末行 > 64KB 首窗：首窗末行是截断 JSON → 扩大窗口重试取到完整行
            let big = "x".repeat(70 * 1024);
            let lines = vec![
                line(serde_json::json!({ "type": "user", "message": { "content": "第一轮" } })),
                line(serde_json::json!({ "type": "assistant", "message": { "content": big } })),
            ];
            let p = temp_jsonl("lastbig", &(lines.join("\n") + "\n"));
            let got = last_jsonl_message(&p);
            assert_eq!(got.chars().count(), 80);
            assert!(got.starts_with("xxx"));
        }

        #[test]
        fn last_jsonl_missing_file_returns_empty() {
            let p = std::env::temp_dir().join(format!("aide-page-missing-{}", std::process::id()));
            let _ = std::fs::remove_file(&p);
            assert_eq!(last_jsonl_message(&p), "");
        }

        #[test]
        fn last_jsonl_single_line_without_newline_uses_whole_buffer() {
            // 单行文件无 \n：整段即末行（走「整读仍无 \n」分支）
            let p = temp_jsonl(
                "lastsingle",
                &line(serde_json::json!({ "type": "user", "message": { "content": "唯一一行" } })),
            );
            assert_eq!(last_jsonl_message(&p), "唯一一行");
        }

        #[test]
        fn last_message_no_content_returns_empty() {
            assert_eq!(last_message_text(r#"{"type":"assistant"}"#), "");
        }

        #[test]
        fn last_message_non_string_non_array_content_returns_empty() {
            assert_eq!(last_message_text(r#"{"type":"assistant","message":{"content":42}}"#), "");
        }

        #[test]
        fn last_message_empty_string_content_returns_empty() {
            assert_eq!(last_message_text(r#"{"type":"assistant","message":{"content":""}}"#), "");
        }

        // ── load_messages_blocking 定位 + 分派（真实 projects 目录,既有元数据测试同款惯例）──

        #[test]
        fn load_messages_result_serializes_camel_case() {
            // 前端读 result.nextOffsetBytes——缺 camelCase 时拿到 undefined →
            // tailOffset=undefined → hasMore 恒 false → 预览上滚取回永不触发
            let r = LoadMessagesResult { messages: Vec::new(), next_offset_bytes: 42, end_offset_bytes: 84 };
            let s = serde_json::to_string(&r).unwrap();
            assert!(s.contains("\"nextOffsetBytes\":42"), "got: {s}");
            assert!(s.contains("\"endOffsetBytes\":84"), "got: {s}");
            assert!(!s.contains("next_offset_bytes"));
            assert!(!s.contains("end_offset_bytes"));
        }

        #[test]
        fn load_messages_blocking_missing_file_returns_empty() {
            // 不存在的 session id → 找不到 .jsonl → 空页 + 0 游标
            let result =
                load_messages_blocking(format!("aide-page-none-{}", std::process::id()), None, None)
                    .unwrap();
            assert!(result.messages.is_empty());
            assert_eq!(result.next_offset_bytes, 0);
        }

        #[test]
        fn load_messages_blocking_real_file_paginates_and_full_reads() {
            // 写真实 claude projects 目录下的临时 .jsonl（唯一 id + 前后清理，仓库惯例）
            let id = format!("aide-page-probe-{}", std::process::id());
            let projects_dir = claude_projects_dir();
            let probe_dir = projects_dir.join(format!("aide-page-probe-dir-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&probe_dir);
            std::fs::create_dir_all(&probe_dir).unwrap();
            let path = probe_dir.join(format!("{}.jsonl", id));
            std::fs::write(&path, standard_lines().join("\n") + "\n").unwrap();
            // 分页取尾部一页（预算 = 尾部 2 行字节和 − 1）
            let page = load_messages_blocking(id.clone(), None, Some(budget_tail_lines(&standard_lines(), 2)))
                .unwrap();
            assert_eq!(page.messages.len(), 2);
            assert!(page.next_offset_bytes > 0);
            // 缺省 = 整读
            let full = load_messages_blocking(id, None, None).unwrap();
            assert_eq!(full.messages.len(), 6);
            assert_eq!(full.next_offset_bytes, 0);
            let _ = std::fs::remove_dir_all(&probe_dir);
        }

        // ── split_lines 非法 UTF-8 行跳过 / parse 第一遍混合 block ──

        #[test]
        fn split_lines_skips_invalid_utf8_line() {
            let mut bytes = Vec::new();
            bytes.extend_from_slice(b"{\"type\":\"user\",\"message\":{\"content\":\"ok\"}}\n");
            bytes.extend_from_slice(&[0xff, 0xfe, 0x80]); // 非法 UTF-8 序列
            bytes.push(b'\n');
            bytes.extend_from_slice(b"{\"type\":\"assistant\",\"message\":{\"content\":\"x\"}}\n");
            let (lines, starts) = split_lines(&bytes, 0);
            assert_eq!(lines.len(), 2, "非法 UTF-8 行被跳过");
            assert_eq!(starts.len(), 2);
            assert!(lines[0].contains("ok"));
            assert!(lines[1].contains("\"x\""));
        }

        #[test]
        fn parse_first_pass_skips_non_tool_result_blocks() {
            // user 行 content 数组里 text 与 tool_result 混合：第一遍只收 tool_result，
            // text 跳过（不成为回填条目）；第二遍该行因含 text block 成为真实消息
            let lines = vec![line(serde_json::json!({
                "type": "user",
                "message": { "content": [
                    { "type": "text", "text": "真人说一句" },
                    { "type": "tool_result", "tool_use_id": "t1", "content": "out", "is_error": false },
                ] },
            }))];
            let parsed = parse_transcript_lines_with_starts(&lines);
            assert_eq!(parsed.len(), 1);
            assert_eq!(parsed[0].0.role, "user");
            assert!(matches!(&parsed[0].0.blocks[..], [HistoryBlock::Text { text }] if text == "真人说一句"));
        }

        // ── changes 落盘：append（JSONL 追加）/ save（全量覆盖）/ load（双格式兼容）──

        fn change_round(index: u32) -> ChangeRoundData {
            ChangeRoundData {
                index,
                time: format!("12:0{index}"),
                files: vec![ChangeFileData {
                    path: format!("src/a{index}.ts"),
                    status: "M".to_string(),
                    additions: 1,
                    deletions: 0,
                }],
                rewind_to: Some(100 + index as u64),
                prompt: Some(format!("提问 {index}")),
            }
        }

        fn changes_path(id: &str) -> std::path::PathBuf {
            our_sessions_dir().join(format!("{id}-changes.json"))
        }

        #[test]
        fn changes_append_then_load_round_trips() {
            // append 两次 → load 回读两轮、顺序正确（JSONL 路径：exists 真 + starts_with 假 + 非空行）
            let id = format!("test-changes-append-{}", std::process::id());
            let path = changes_path(&id);
            let _ = std::fs::remove_file(&path);

            append_session_change_blocking(id.clone(), change_round(1)).unwrap();
            append_session_change_blocking(id.clone(), change_round(2)).unwrap();

            let rounds = load_session_changes_blocking(id.clone()).unwrap();
            assert_eq!(rounds.len(), 2);
            assert_eq!(rounds[0].index, 1);
            assert_eq!(rounds[0].prompt.as_deref(), Some("提问 1"));
            assert_eq!(rounds[1].index, 2);

            let _ = std::fs::remove_file(&path);
        }

        #[test]
        fn changes_save_full_overwrite_then_load() {
            // 全量覆盖语义（revert 场景）：save 两轮 → load 两轮；再 save 单轮 → load 只剩该轮
            let id = format!("test-changes-save-{}", std::process::id());
            let path = changes_path(&id);
            let _ = std::fs::remove_file(&path);

            save_session_changes_blocking(id.clone(), vec![change_round(1), change_round(2)]).unwrap();
            assert_eq!(load_session_changes_blocking(id.clone()).unwrap().len(), 2);

            save_session_changes_blocking(id.clone(), vec![change_round(3)]).unwrap();
            let rounds = load_session_changes_blocking(id.clone()).unwrap();
            assert_eq!(rounds.len(), 1);
            assert_eq!(rounds[0].index, 3);

            let _ = std::fs::remove_file(&path);
        }

        #[test]
        fn changes_load_accepts_legacy_pretty_array() {
            // 2026-08-26 前的 pretty 数组格式仍能读（starts_with '[' 真分支）
            let id = format!("test-changes-legacy-{}", std::process::id());
            let path = changes_path(&id);
            let _ = std::fs::remove_file(&path);
            fs::create_dir_all(our_sessions_dir()).unwrap();
            fs::write(&path, serde_json::to_string_pretty(&vec![change_round(1), change_round(2)]).unwrap()).unwrap();

            let rounds = load_session_changes_blocking(id.clone()).unwrap();
            assert_eq!(rounds.len(), 2);
            assert_eq!(rounds[1].rewind_to, Some(102));

            let _ = std::fs::remove_file(&path);
        }

        #[test]
        fn changes_load_missing_file_returns_empty() {
            // 会话无变更文件（exists 假分支）→ 空 Vec，不是错误
            let id = format!("test-changes-missing-{}", std::process::id());
            let path = changes_path(&id);
            let _ = std::fs::remove_file(&path);

            let rounds = load_session_changes_blocking(id.clone()).unwrap();
            assert!(rounds.is_empty());

            let _ = std::fs::remove_file(&path);
        }

        #[test]
        fn changes_load_skips_blank_lines() {
            // JSONL 中间出现空行（截断/手编残留）→ 跳过，不误判为损坏（空行真分支）
            let id = format!("test-changes-blank-{}", std::process::id());
            let path = changes_path(&id);
            let _ = std::fs::remove_file(&path);
            fs::create_dir_all(our_sessions_dir()).unwrap();
            let mut content = serde_json::to_string(&change_round(1)).unwrap();
            content.push_str("\n\n");
            content.push_str(&serde_json::to_string(&change_round(2)).unwrap());
            content.push('\n');
            fs::write(&path, content).unwrap();

            let rounds = load_session_changes_blocking(id.clone()).unwrap();
            assert_eq!(rounds.len(), 2);

            let _ = std::fs::remove_file(&path);
        }

        #[test]
        fn changes_load_rejects_invalid_line() {
            // JSONL 行非 JSON → Err（parse 错误臂）：损坏文件宁可报错也不静默丢数据
            let id = format!("test-changes-corrupt-{}", std::process::id());
            let path = changes_path(&id);
            let _ = std::fs::remove_file(&path);
            fs::create_dir_all(our_sessions_dir()).unwrap();
            fs::write(&path, "not json\n").unwrap();

            assert!(load_session_changes_blocking(id.clone()).is_err());

            let _ = std::fs::remove_file(&path);
        }

        #[test]
        fn changes_load_rejects_corrupt_legacy_array() {
            // 旧 pretty 数组格式损坏 → Err（starts_with '[' 分支的 from_str 错误臂）
            let id = format!("test-changes-corrupt-legacy-{}", std::process::id());
            let path = changes_path(&id);
            let _ = std::fs::remove_file(&path);
            fs::create_dir_all(our_sessions_dir()).unwrap();
            fs::write(&path, "[{\"index\": 1, broken").unwrap();

            assert!(load_session_changes_blocking(id.clone()).is_err());

            let _ = std::fs::remove_file(&path);
        }

        // ── 尾部探测（region_has_parseable_messages）──

        fn queue_op_line() -> String {
            serde_json::json!({ "type": "queue-operation", "operation": "enqueue", "timestamp": "2026-08-25T00:00:00Z" }).to_string()
        }

        fn image_only_user_line() -> String {
            serde_json::json!({ "type": "user", "message": { "content": [{ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "AAAA" } }] } }).to_string()
        }

        #[test]
        fn region_has_parseable_messages_detects_real_message() {
            // 真实 user 文本行 → true
            let p = temp_jsonl("regreal", &standard_lines().join("\n"));
            let file = fs::File::open(&p).unwrap();
            let file_len = file.metadata().unwrap().len();
            assert!(region_has_parseable_messages(&file, file_len).unwrap());
        }

        #[test]
        fn region_has_parseable_messages_empty_head_region() {
            // 头部只有 queue-operation + 图片 user 行（不可渲染）→ false
            let content = queue_op_line() + "\n" + &queue_op_line() + "\n" + &image_only_user_line() + "\n";
            let p = temp_jsonl("emptyhead", &content);
            let file = fs::File::open(&p).unwrap();
            assert!(!region_has_parseable_messages(&file, content.len() as u64).unwrap());
        }

        #[test]
        fn region_has_parseable_messages_synthetic_user_skipped() {
            // isMeta 合成 user 行不算（parse 时会过滤，探测必须同口径）
            let content = serde_json::json!({ "type": "user", "isMeta": true, "message": { "content": "skill 注入" } }).to_string() + "\n";
            let p = temp_jsonl("synthetic", &content);
            let file = fs::File::open(&p).unwrap();
            assert!(!region_has_parseable_messages(&file, content.len() as u64).unwrap());
        }

        #[test]
        fn tail_probe_zeroes_next_offset_when_head_region_empty() {
            // 文件 = 头部空区（queue + 图片）+ 尾部真实消息（"你好"）：尾部页的
            // next 指向头部空区起点 → 探测发现无可解析消息 → next 归 0（按钮不悬空）。
            let mut lines = vec![queue_op_line(), image_only_user_line()];
            lines.push(line(serde_json::json!({ "type": "user", "message": { "content": "你好" } })));
            lines.push(line(serde_json::json!({ "type": "assistant", "message": { "content": "你好" } })));
            let p = temp_jsonl("emptyheadpage", &(lines.join("\n") + "\n"));
            // 预算 = 尾部 2 条消息字节和 → 尾部页 = 2 条 → next 指向头部区起点
            let page = page_from_file(&p, None, budget_tail_lines(&lines, 2));
            assert_eq!(page.messages.len(), 2);
            assert_eq!(page.next_offset_bytes, 0, "头部空区：next 必须归 0，按钮不悬空");
            let _ = std::fs::remove_file(&p);
        }

        #[test]
        fn tail_probe_keeps_offset_when_head_has_more_messages() {
            // 头部有真实消息：探测保留 next（下一页确实还有内容）
            let mut lines = standard_lines();
            lines.push(line(serde_json::json!({ "type": "user", "message": { "content": "最后一轮" } })));
            lines.push(line(serde_json::json!({ "type": "assistant", "message": { "content": "嗯" } })));
            let p = temp_jsonl("headreal", &(lines.join("\n") + "\n"));
            let page = page_from_file(&p, None, budget_tail_lines(&lines, 2));
            assert_eq!(page.messages.len(), 2);
            assert!(page.next_offset_bytes > 0, "头部还有真实消息：next 保留");
            let _ = std::fs::remove_file(&p);
        }
    }
}
