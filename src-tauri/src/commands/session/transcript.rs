// transcript 纯解析域（functional core）：把 Claude CLI 落盘的 .jsonl 行
// 重建为前端历史消息，不摸文件系统。分页 / 命令外壳在 super::history。

use serde_json::Value;

use crate::commands::{ChatMessageItem, HistoryBlock};

/// Agent/Task 是子代理调用（CC v2.1.63 把 Task 改名成 Agent，两个都认，跟
/// agent-sidecar/src/subagents.ts 的 SUBAGENT_TOOL_NAMES 保持同一份清单——两边
/// 语言不同没法共享常量，靠注释手动同步）。这次历史重建不管子代理：它们内部的
/// 分步进度 Claude CLI 从不落盘，做了也补不全，维持原有降级行为——整段跳过。
pub(super) const SUBAGENT_TOOL_NAMES: [&str; 2] = ["Agent", "Task"];

/// 把 Claude CLI 落盘的会话 `.jsonl`（每行一条消息）解析成前端要渲染的历史消息，
/// 按原始顺序重建 text/tool_call 两种内容块（`HistoryBlock`）。从 `load_messages`
/// 抽出来是纯函数、不摸文件系统，方便直接拿假 transcript 单测。
///
/// 两遍扫描：tool_result 落在稍后（也可能更早，顺序不保证）的另一行 user 消息里，
/// 必须先扫一遍全量建好 `tool_use_id → (content, is_error)` 的表，再回填进对应的
/// tool_call 块，不能假设 tool_result 总跟在 tool_use 后面紧挨着那一行。
pub(super) fn parse_transcript_lines(lines: &[String]) -> Vec<ChatMessageItem> {
    parse_transcript_lines_with_starts(lines)
        .into_iter()
        .map(|(m, _)| m)
        .collect()
}

/// `parse_transcript_lines` 的变体：额外记录每条消息的起始行号（相对收集行），
/// 供字节游标分页定位页首。原函数改为调用它并丢弃行号，现有测试零改动。
pub(super) fn parse_transcript_lines_with_starts(
    lines: &[String],
) -> Vec<(ChatMessageItem, usize)> {
    let mut tool_results: std::collections::HashMap<String, (String, bool)> =
        std::collections::HashMap::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
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
            let is_error = block
                .get("is_error")
                .and_then(|b| b.as_bool())
                .unwrap_or(false);
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
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
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
                vec![HistoryBlock::Text {
                    text: s.to_string(),
                }]
            }
        } else if let Some(arr) = content_val.as_array() {
            arr.iter()
                .filter_map(|block| match block.get("type").and_then(|t| t.as_str()) {
                    Some("text") => {
                        block
                            .get("text")
                            .and_then(|t| t.as_str())
                            .map(|t| HistoryBlock::Text {
                                text: t.to_string(),
                            })
                    }
                    Some("thinking") => block.get("thinking").and_then(|t| t.as_str()).map(|t| {
                        HistoryBlock::Thinking {
                            text: t.to_string(),
                        }
                    }),
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
                        Some(HistoryBlock::ToolCall {
                            id,
                            name,
                            input,
                            result,
                            is_error,
                        })
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
        messages.push((
            ChatMessageItem {
                role: role.to_string(),
                blocks,
                timestamp: i as u64,
            },
            i,
        ));
    }

    messages
}

/// Whether a raw JSONL "user"-type entry is SDK/CLI-synthesized rather than
/// something the human actually typed (Skill injections, interrupt
/// placeholders, compaction summaries, background task notifications).
/// Confirmed against real transcripts: genuine typed messages never carry
/// these markers, and carrying one is never a byproduct of genuine input.
pub(super) fn is_synthetic_user_entry(v: &Value) -> bool {
    if v.get("isMeta").and_then(|b| b.as_bool()).unwrap_or(false) {
        return true;
    }
    if v.get("interruptedMessageId").is_some() {
        return true;
    }
    if v.get("isCompactSummary")
        .and_then(|b| b.as_bool())
        .unwrap_or(false)
    {
        return true;
    }
    if let Some(kind) = v
        .get("origin")
        .and_then(|o| o.get("kind"))
        .and_then(|k| k.as_str())
    {
        if kind != "human" {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(v: serde_json::Value) -> String {
        v.to_string()
    }

    // 回归：真实会话记录里，Skill 注入(isMeta)、中断占位符
    // (interruptedMessageId)、压缩摘要(isCompactSummary)、后台任务通知
    // (origin.kind != "human") 都以 role:"user" 落盘，但都不是人类真正打的字——
    // 曾经被 load_messages 原样当用户消息渲染，在 UI 上显示成"用户说的话"。
    #[test]
    fn synthetic_user_entries_are_detected() {
        assert!(is_synthetic_user_entry(
            &serde_json::json!({ "isMeta": true })
        ));
        assert!(is_synthetic_user_entry(
            &serde_json::json!({ "interruptedMessageId": "msg_1" })
        ));
        assert!(is_synthetic_user_entry(
            &serde_json::json!({ "isCompactSummary": true })
        ));
        assert!(is_synthetic_user_entry(
            &serde_json::json!({ "origin": { "kind": "task-notification" } })
        ));
    }

    #[test]
    fn genuine_human_entries_are_not_filtered() {
        // 新版 SDK：显式标注 origin.kind == "human"
        assert!(!is_synthetic_user_entry(
            &serde_json::json!({ "origin": { "kind": "human" } })
        ));
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
            assert!(
                matches!(&messages[0].blocks[..], [HistoryBlock::Text { text }] if text == "你好")
            );
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
            assert_eq!(
                messages.len(),
                1,
                "纯 tool_result 的 user 行不应该单独变成一条消息"
            );
            assert_eq!(messages[0].blocks.len(), 2);
            assert!(
                matches!(&messages[0].blocks[0], HistoryBlock::Text { text } if text == "我看一下这个文件")
            );
            match &messages[0].blocks[1] {
                HistoryBlock::ToolCall {
                    id,
                    name,
                    result,
                    is_error,
                    ..
                } => {
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
                HistoryBlock::ToolCall {
                    result, is_error, ..
                } => {
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
            assert!(
                matches!(&messages[0].blocks[0], HistoryBlock::Text { text } if text == "我先看看情况")
            );
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
            assert_eq!(
                roles,
                vec!["user", "claude", "user", "claude"],
                "真实 user 行仍然隔断回合"
            );
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
        assert!(
            matches!(&parsed[0].0.blocks[..], [HistoryBlock::Text { text }] if text == "真人说一句")
        );
    }
}
