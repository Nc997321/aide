// 历史消息分页：字节游标反向分页 + 尾部探测。纯解析在 super::parse。

use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use super::parse::{
    is_synthetic_user_entry, parse_transcript_lines, parse_transcript_lines_with_starts,
    SUBAGENT_TOOL_NAMES,
};
use super::{ChatMessageItem, LoadMessagesResult};

/// 读一页历史（参数语义见桌面 `load_messages` 命令）：`limit` = None 整读；否则
/// 从 `offset_bytes`（缺省文件尾）往前取 `limit` 字节预算的一页。
pub fn load_messages_at(
    jsonl_path: &Path,
    offset_bytes: Option<u64>,
    limit: Option<u32>,
) -> Result<LoadMessagesResult, String> {
    let file =
        fs::File::open(jsonl_path).map_err(|e| format!("Failed to open session file: {}", e))?;
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
            let next_offset = if next_offset > 0
                && next_offset <= CHUNK_SIZE
                && !region_has_parseable_messages(file, next_offset)?
            {
                0
            } else {
                next_offset
            };
            return Ok(LoadMessagesResult {
                messages,
                next_offset_bytes: next_offset,
                end_offset_bytes: end,
            });
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
    f.seek(SeekFrom::Start(0))
        .map_err(|e| format!("Failed to seek: {}", e))?;
    let mut buf = vec![0u8; end as usize];
    f.read_exact(&mut buf)
        .map_err(|e| format!("Failed to read region: {}", e))?;
    for line in split_lines(&buf, 0).0 {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let msg_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if msg_type == "user" && is_synthetic_user_entry(&v) {
            continue;
        }
        let Some(content) = v.get("message").and_then(|m| m.get("content")) else {
            continue;
        };
        let has_block = match content {
            Value::String(s) => !s.is_empty(),
            Value::Array(blocks) => {
                blocks
                    .iter()
                    .any(|b| match b.get("type").and_then(|t| t.as_str()) {
                        Some("text") | Some("thinking") => true,
                        Some("tool_use") => {
                            let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("");
                            !SUBAGENT_TOOL_NAMES.contains(&name)
                        }
                        _ => false,
                    })
            }
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
    f.seek(SeekFrom::Start(start))
        .map_err(|e| format!("Failed to seek: {}", e))?;
    f.read_exact(&mut buf)
        .map_err(|e| format!("Failed to read chunk: {}", e))?;
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
        let next_line = parsed
            .get(idx + 1)
            .map(|(_, li)| *li)
            .unwrap_or(lines.len());
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
        let next_line = parsed
            .get(start + 1)
            .map(|(_, li)| *li)
            .unwrap_or(lines.len());
        bytes -= lines[line_idx..next_line]
            .iter()
            .map(|l| l.len())
            .sum::<usize>();
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

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::HistoryBlock;

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
            line(
                serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "你好,有什么可以帮你?" }] } }),
            ),
            line(
                serde_json::json!({ "type": "user", "message": { "content": "帮我看看这个文件" } }),
            ),
            line(
                serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use", "id": "t1", "name": "Read", "input": { "file_path": "a.ts" } }] } }),
            ),
            line(
                serde_json::json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "文件内容……", "is_error": false }] } }),
            ),
            line(
                serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "文件内容如下" }] } }),
            ),
            line(serde_json::json!({ "type": "user", "message": { "content": "谢谢" } })),
            line(
                serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "不客气" }] } }),
            ),
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
        let mid =
            read_page_backwards(&file, file_len, Some(tail.next_offset_bytes.max(1)), BIG).unwrap();
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
        content.push_str(
            "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"半截",
        );
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
            line(
                serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "a" }] } }),
            ),
            line(
                serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "b" }] } }),
            ),
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
        assert!(
            matches!(&result.messages[0].blocks[..], [HistoryBlock::Text { text }] if text == "谢谢")
        );
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
            line(
                serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": big_text }] } }),
            ),
            line(serde_json::json!({ "type": "user", "message": { "content": "q1" } })),
        ];
        let p = temp_jsonl("oversized", &(lines.join("\n") + "\n"));
        // 预算 100 字节 << 大行（~5KB）：页 = 最新 1 条（q1 user 行保底）
        let result = page_from_file(&p, None, 100);
        assert_eq!(result.messages.len(), 1);
        assert_eq!(result.messages[0].role, "user");
        assert!(
            matches!(&result.messages[0].blocks[..], [HistoryBlock::Text { text }] if text == "q1")
        );
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
            line(
                serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": big_text }] } }),
            ),
            line(
                serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "ls" } }] } }),
            ),
            line(
                serde_json::json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "out", "is_error": false }] } }),
            ),
            line(
                serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "ok" }] } }),
            ),
        ];
        let p = temp_jsonl("nouser", &(lines.join("\n") + "\n"));
        // 预算 100B：尾部累计仅够 1-2 条（都是 assistant 行），预算内无 user →
        // 页非空（回退保留）+ nextOffset 继续（>0，更早的 q0 还在）
        let result = page_from_file(&p, None, 100);
        assert!(!result.messages.is_empty(), "预算内无 user 时不得返回空页");
        assert!(
            result.next_offset_bytes > 0,
            "游标必须继续（更早的 user 还在）"
        );
        // 继续取下一页 → 最终取回全部（含 q0 回合），无死循环
        let mut all: Vec<String> = Vec::new();
        let mut offset: Option<u64> = Some(result.next_offset_bytes);
        all.extend(result.messages.iter().map(|m| m.role.clone()));
        let mut guard = 0;
        while let Some(off) = offset {
            let page = page_from_file(&p, Some(off), 100);
            all.extend(page.messages.iter().map(|m| m.role.clone()));
            offset = if page.next_offset_bytes == 0 {
                None
            } else {
                Some(page.next_offset_bytes)
            };
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
            line(
                serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "a" }] } }),
            ),
            line(serde_json::json!({ "type": "user", "message": { "content": "q1" } })),
            line(
                serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "ls" } }] } }),
            ),
            line(
                serde_json::json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "out", "is_error": false }] } }),
            ),
            line(
                serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "b" }] } }),
            ),
            line(serde_json::json!({ "type": "user", "message": { "content": "q2" } })),
            line(
                serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "ok" }] } }),
            ),
        ];
        let p = temp_jsonl("samepage", &(lines.join("\n") + "\n"));
        // 页1 = 最新 2 条：[user q2, claude ok]（预算 = 尾部 2 行字节和 − 1）
        let page1 = page_from_file(&p, None, budget_tail_lines(&lines, 2));
        assert_eq!(page1.messages.len(), 2);
        // 页2 = [q1 回合]（行 2..6，含 tool_result 行），t1 的 tool_use 与 result
        // 同页收集 → 回填成功
        let page2 = page_from_file(
            &p,
            Some(page1.next_offset_bytes),
            budget_line_range(&lines, 2, 6),
        );
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
            line(
                serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": big_text }] } }),
            ),
            line(serde_json::json!({ "type": "user", "message": { "content": "q2" } })),
            line(
                serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "ok" }] } }),
            ),
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
        assert!(
            matches!(&result.messages[0].blocks[..], [HistoryBlock::Text { text }] if text == "谢谢")
        );
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
        assert_eq!(
            all,
            vec!["user", "claude", "user", "claude", "user", "claude"]
        );
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
        let result = page_from_file(
            &p,
            Some(page1.next_offset_bytes),
            budget_tail_lines(&lines[..3], 2),
        );
        assert_eq!(result.messages.len(), 1);
        assert_eq!(result.messages[0].role, "user");
        assert!(
            matches!(&result.messages[0].blocks[..], [HistoryBlock::Text { text }] if text == "帮我看看这个文件")
        );
        assert!(result.next_offset_bytes > 0, "更早页 [你好] 还在");
        // 游标链：再取一页（BIG = 剩余全量）= [L0 user, L1 assistant]，到文件头
        let final_page = page_from_file(&p, Some(result.next_offset_bytes), BIG);
        assert_eq!(final_page.messages.len(), 2);
        assert_eq!(final_page.messages[0].role, "user");
        assert_eq!(final_page.next_offset_bytes, 0);
    }
    // ── load_messages_at 分派 ──

    #[test]
    fn load_messages_result_serializes_camel_case() {
        // 前端读 result.nextOffsetBytes——缺 camelCase 时拿到 undefined →
        // tailOffset=undefined → hasMore 恒 false → 预览上滚取回永不触发
        let r = LoadMessagesResult {
            messages: Vec::new(),
            next_offset_bytes: 42,
            end_offset_bytes: 84,
        };
        let s = serde_json::to_string(&r).unwrap();
        assert!(s.contains("\"nextOffsetBytes\":42"), "got: {s}");
        assert!(s.contains("\"endOffsetBytes\":84"), "got: {s}");
        assert!(!s.contains("next_offset_bytes"));
        assert!(!s.contains("end_offset_bytes"));
    }

    #[test]
    fn load_messages_at_missing_file_errors() {
        let p = std::env::temp_dir().join(format!("aide-page-none-{}.jsonl", std::process::id()));
        assert!(load_messages_at(&p, None, None).is_err());
    }

    #[test]
    fn load_messages_at_paginates_and_full_reads() {
        let p = temp_jsonl("at", &(standard_lines().join("\n") + "\n"));
        let page = load_messages_at(&p, None, Some(budget_tail_lines(&standard_lines(), 2))).unwrap();
        assert_eq!(page.messages.len(), 2);
        assert!(page.next_offset_bytes > 0);
        let full = load_messages_at(&p, None, None).unwrap();
        assert_eq!(full.messages.len(), 6);
        assert_eq!(full.next_offset_bytes, 0);
        let _ = std::fs::remove_file(&p);
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
        let content =
            queue_op_line() + "\n" + &queue_op_line() + "\n" + &image_only_user_line() + "\n";
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
        lines.push(line(
            serde_json::json!({ "type": "user", "message": { "content": "你好" } }),
        ));
        lines.push(line(
            serde_json::json!({ "type": "assistant", "message": { "content": "你好" } }),
        ));
        let p = temp_jsonl("emptyheadpage", &(lines.join("\n") + "\n"));
        // 预算 = 尾部 2 条消息字节和 → 尾部页 = 2 条 → next 指向头部区起点
        let page = page_from_file(&p, None, budget_tail_lines(&lines, 2));
        assert_eq!(page.messages.len(), 2);
        assert_eq!(
            page.next_offset_bytes, 0,
            "头部空区：next 必须归 0，按钮不悬空"
        );
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn tail_probe_keeps_offset_when_head_has_more_messages() {
        // 头部有真实消息：探测保留 next（下一页确实还有内容）
        let mut lines = standard_lines();
        lines.push(line(
            serde_json::json!({ "type": "user", "message": { "content": "最后一轮" } }),
        ));
        lines.push(line(
            serde_json::json!({ "type": "assistant", "message": { "content": "嗯" } }),
        ));
        let p = temp_jsonl("headreal", &(lines.join("\n") + "\n"));
        let page = page_from_file(&p, None, budget_tail_lines(&lines, 2));
        assert_eq!(page.messages.len(), 2);
        assert!(page.next_offset_bytes > 0, "头部还有真实消息：next 保留");
        let _ = std::fs::remove_file(&p);
    }
}
