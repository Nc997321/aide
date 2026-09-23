//! agent-sidecar ↔ 内嵌浏览器的协议桥（主进程侧**纯函数**层，无 IO）。
//!
//! 形制照 `codegraph/agent_bridge.rs`（同一套 request_id 配对）：sidecar 工具 emit
//! `browser_query` 事件 → `runtime/mod.rs` 拦截（不转发 Vue）→ 执行体
//! `runtime/browser_agent.rs` 驱动门面 → 结果以 `browser_result` 经 stdin 回写。
//!
//! # op 面刻意收窄（这是「通用 vs 补丁」的落点）
//!
//! 内核只暴露四个**机制**词汇，不认识任何页面语义、更不认识站点：
//! - `ListViews` —— 发现有哪些视图可操作（view_id 消歧的数据源）
//! - `Eval` —— 在视图里执行脚本、取回 JSON
//! - `CallCdp` —— 裸 CDP（真实输入事件 `Input.dispatchMouseEvent`、文件上传）
//! - `InitScript` —— 给**后续所有文档**注入启动脚本（宿主 API；CDP 的同类方法在本机 WebView2
//!   上被接受但不交货，那条路不能当注入路用）
//!
//! `read` / `snapshot` / `act` **都不进协议**：它们由 sidecar 组合投影脚本后走 `Eval`/`CallCdp`。
//! 于是「换个站点」= 换 sidecar 里的脚本数据，本文件一行不动。

use serde_json::{json, Value};

/// 一条 `browser_query` 的业务载荷。
#[derive(Debug, Clone, PartialEq)]
pub enum BrowserQuery {
    ListViews,
    /// 在 `view_id`（`None` = 由执行体按规则解析）里跑 `script`。
    Eval {
        view_id: Option<String>,
        script: String,
    },
    /// 裸 CDP 调用。`params` 原样透传给 `CallDevToolsProtocolMethod`。
    CallCdp {
        view_id: Option<String>,
        method: String,
        params: Value,
    },
    /// 给**后续所有文档**注入启动脚本（宿主 API `AddScriptToExecuteOnDocumentCreated`）。
    ///
    /// 与 `CallCdp` 的 `Page.addScriptToEvaluateOnNewDocument` 是同一件事的两条路：CDP 那条在
    /// 本机 WebView2 上**被接受但不交货**（静默失败，无从凭错误回退），故单独立一条宿主通道。
    /// 消费方是 sidecar 的 recorder（页面加载期就要在的探针）。
    InitScript {
        view_id: Option<String>,
        script: String,
    },
    /// 请面板把某个视图露到前台。**只是请求**：显示权在 UI（空标签没有视图、还有宽度档与
    /// 浮层让位这些纯 UI 状态），所以这一条不改任何领域状态，只广播 `browser-focus`。
    Focus {
        view_id: Option<String>,
    },
    /// 建一个**自己的**后台视图（默认视口、parked）。返回的 `view_id` 由 agent 自己记着——
    /// 多 agent 下这就是"哪个 tab 是我的"的唯一可靠答案（三个 tab 挂同一个 dev server 时
    /// URL 与标题都分不出来）。
    Open {
        url: String,
        label: Option<String>,
    },
    /// 关掉一个视图（agent 用完自己收）。
    Close { view_id: Option<String> },
    Navigate {
        view_id: Option<String>,
        url: String,
    },
    Back { view_id: Option<String> },
    Forward { view_id: Option<String> },
    /// op 缺失/未知或载荷不全。
    ///
    /// **刻意不静默丢弃**（对比 codegraph 的「解析失败即忽略」）：回一条错误让 sidecar 立刻
    /// 失败并把原因写进工具返回，而不是干等客户端超时。协议不匹配是 bug，越早越响越好。
    Malformed(String),
}

impl BrowserQuery {
    /// 回包里的 op 名（诊断用；`Malformed` 归为 `"malformed"`）。
    pub fn op_name(&self) -> &'static str {
        match self {
            Self::ListViews => "list_views",
            Self::Eval { .. } => "eval",
            Self::CallCdp { .. } => "call_cdp",
            Self::InitScript { .. } => "init_script",
            Self::Focus { .. } => "focus",
            Self::Open { .. } => "open",
            Self::Close { .. } => "close",
            Self::Navigate { .. } => "navigate",
            Self::Back { .. } => "back",
            Self::Forward { .. } => "forward",
            Self::Malformed(_) => "malformed",
        }
    }
}

/// 一条已校验的 `browser_query` 事件。
#[derive(Debug, Clone, PartialEq)]
pub struct BrowserQueryRequest {
    pub request_id: String,
    pub query: BrowserQuery,
}

/// 解析事件。
///
/// - `None` = **不是**本桥的事件（调用方继续走普通事件路由/心跳/诊断）；
/// - `Some(Malformed)` = 是本桥事件但载荷不合法（回错误，不静默）。
pub fn parse_browser_query(event: &Value) -> Option<BrowserQueryRequest> {
    if event.get("type").and_then(|t| t.as_str()) != Some("browser_query") {
        return None;
    }
    // 缺 request_id 就没法配对回包 —— 只能当不是本桥的事件（同 codegraph 语义）。
    let request_id = event.get("request_id")?.as_str()?.to_string();
    Some(BrowserQueryRequest {
        request_id,
        query: parse_query(event),
    })
}

fn parse_query(event: &Value) -> BrowserQuery {
    let Some(op) = event.get("op").and_then(|v| v.as_str()) else {
        return BrowserQuery::Malformed("missing `op`".into());
    };
    match op {
        "list_views" => BrowserQuery::ListViews,
        "eval" => match event.get("script").and_then(|v| v.as_str()) {
            Some(script) => BrowserQuery::Eval {
                view_id: opt_str(event, "view_id"),
                script: script.to_string(),
            },
            None => BrowserQuery::Malformed("eval requires a string `script`".into()),
        },
        "call_cdp" => match event.get("method").and_then(|v| v.as_str()) {
            Some(method) => BrowserQuery::CallCdp {
                view_id: opt_str(event, "view_id"),
                method: method.to_string(),
                params: event.get("params").cloned().unwrap_or(Value::Null),
            },
            None => BrowserQuery::Malformed("call_cdp requires a string `method`".into()),
        },
        "init_script" => match event.get("script").and_then(|v| v.as_str()) {
            Some(script) => BrowserQuery::InitScript {
                view_id: opt_str(event, "view_id"),
                script: script.to_string(),
            },
            None => BrowserQuery::Malformed("init_script requires a string `script`".into()),
        },
        "focus" => BrowserQuery::Focus {
            view_id: opt_str(event, "view_id"),
        },
        "open" => match event.get("url").and_then(|v| v.as_str()) {
            Some(url) => BrowserQuery::Open {
                url: url.to_string(),
                label: opt_str(event, "label"),
            },
            None => BrowserQuery::Malformed("open requires a string `url`".into()),
        },
        "close" => BrowserQuery::Close {
            view_id: opt_str(event, "view_id"),
        },
        "navigate" => match event.get("url").and_then(|v| v.as_str()) {
            Some(url) => BrowserQuery::Navigate {
                view_id: opt_str(event, "view_id"),
                url: url.to_string(),
            },
            None => BrowserQuery::Malformed("navigate requires a string `url`".into()),
        },
        "back" => BrowserQuery::Back {
            view_id: opt_str(event, "view_id"),
        },
        "forward" => BrowserQuery::Forward {
            view_id: opt_str(event, "view_id"),
        },
        other => BrowserQuery::Malformed(format!("unknown op: {other}")),
    }
}

fn opt_str(event: &Value, key: &str) -> Option<String> {
    event.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

/// 成功回包载荷。
pub fn ok_payload(data: Value) -> Value {
    json!({ "ok": true, "data": data })
}

/// 失败回包载荷。`message` 面向**模型**可读（要能直接指导下一步，不是给开发者看的堆栈）。
pub fn err_payload(message: impl Into<String>) -> Value {
    json!({ "ok": false, "error": message.into() })
}

/// 组装经 stdin 回写的命令行：base payload + `request_id` + `cmd` 标。
pub fn build_result_command(request_id: &str, payload: Value) -> Value {
    let mut v = payload;
    v["cmd"] = Value::String("browser_result".into());
    v["request_id"] = Value::String(request_id.into());
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn non_browser_events_are_not_ours() {
        assert!(parse_browser_query(&json!({"type": "text_delta"})).is_none());
        assert!(
            parse_browser_query(&json!({"type": "codegraph_query", "request_id": "r"})).is_none()
        );
        // 缺 request_id：无法配对回包，当不是本桥事件（同 codegraph 语义）
        assert!(
            parse_browser_query(&json!({"type": "browser_query", "op": "list_views"})).is_none()
        );
    }

    /// focus 是**请求**（显示权在面板）：桥只认识这一个 op，不做任何状态迁移。
    #[test]
    fn parses_focus_op() {
        let r = parse_browser_query(&json!({
            "type": "browser_query", "request_id": "r1", "op": "focus", "view_id": "browser-2"
        }))
        .unwrap();
        assert_eq!(
            r.query,
            BrowserQuery::Focus {
                view_id: Some("browser-2".into())
            }
        );
        assert_eq!(r.query.op_name(), "focus");

        // view_id 缺省 → None（由执行体解析）
        let r = parse_browser_query(&json!({
            "type": "browser_query", "request_id": "r2", "op": "focus"
        }))
        .unwrap();
        assert_eq!(r.query, BrowserQuery::Focus { view_id: None });
    }

    /// tab 级 op 的解析：`open` 必填 url、`navigate` 必填 url，缺了**不静默丢弃**。
    #[test]
    fn parses_tab_lifecycle_ops() {
        let open = parse_browser_query(&json!({
            "type": "browser_query", "request_id": "r", "op": "open",
            "url": "http://localhost:5173/", "label": "vue-admin dev"
        }))
        .unwrap();
        assert_eq!(
            open.query,
            BrowserQuery::Open {
                url: "http://localhost:5173/".into(),
                label: Some("vue-admin dev".into()),
            }
        );
        assert_eq!(open.query.op_name(), "open");

        let nav = parse_browser_query(&json!({
            "type": "browser_query", "request_id": "r", "op": "navigate",
            "view_id": "browser-1", "url": "http://localhost:5173/x"
        }))
        .unwrap();
        assert_eq!(
            nav.query,
            BrowserQuery::Navigate {
                view_id: Some("browser-1".into()),
                url: "http://localhost:5173/x".into(),
            }
        );

        for (op, raw) in [
            ("open", json!({"type": "browser_query", "request_id": "r", "op": "open"})),
            (
                "navigate",
                json!({"type": "browser_query", "request_id": "r", "op": "navigate"}),
            ),
        ] {
            assert!(
                matches!(
                    parse_browser_query(&raw).unwrap().query,
                    BrowserQuery::Malformed(_)
                ),
                "{op} 缺 url 必须 Malformed"
            );
        }

        assert_eq!(
            parse_browser_query(&json!({
                "type": "browser_query", "request_id": "r", "op": "close", "view_id": "browser-3"
            }))
            .unwrap()
            .query,
            BrowserQuery::Close {
                view_id: Some("browser-3".into())
            }
        );
        assert_eq!(
            parse_browser_query(&json!({"type": "browser_query", "request_id": "r", "op": "back"}))
                .unwrap()
                .query,
            BrowserQuery::Back { view_id: None }
        );
        assert_eq!(
            parse_browser_query(&json!({
                "type": "browser_query", "request_id": "r", "op": "forward", "view_id": "browser-1"
            }))
            .unwrap()
            .query,
            BrowserQuery::Forward {
                view_id: Some("browser-1".into())
            }
        );
    }

    #[test]
    fn parses_the_three_ops() {
        let r = parse_browser_query(&json!({
            "type": "browser_query", "request_id": "r1", "op": "list_views"
        }))
        .unwrap();
        assert_eq!(r.request_id, "r1");
        assert_eq!(r.query, BrowserQuery::ListViews);

        let r = parse_browser_query(&json!({
            "type": "browser_query", "request_id": "r2", "op": "eval",
            "view_id": "browser-1", "script": "1+1"
        }))
        .unwrap();
        assert_eq!(
            r.query,
            BrowserQuery::Eval {
                view_id: Some("browser-1".into()),
                script: "1+1".into()
            }
        );

        // view_id 缺省 → None（由执行体按规则解析，不在解析层猜）
        let r = parse_browser_query(&json!({
            "type": "browser_query", "request_id": "r3", "op": "call_cdp",
            "method": "Input.dispatchMouseEvent", "params": {"type": "mouseMoved", "x": 0, "y": 0}
        }))
        .unwrap();
        assert_eq!(
            r.query,
            BrowserQuery::CallCdp {
                view_id: None,
                method: "Input.dispatchMouseEvent".into(),
                params: json!({"type": "mouseMoved", "x": 0, "y": 0}),
            }
        );
    }

    /// `init_script` = 给**未来文档**注入启动脚本的宿主通道（recorder 的注入接缝）。
    /// 载荷形状与 sidecar 的 `queryBrowser({op:"init_script", …})` 逐字对齐——两边对不上
    /// 就是"注册被静默忽略"那一类事故。
    #[test]
    fn parses_init_script_op() {
        let r = parse_browser_query(&json!({
            "type": "browser_query", "request_id": "r1", "op": "init_script",
            "view_id": "browser-2", "script": "window.__rec = 1"
        }))
        .unwrap();
        assert_eq!(
            r.query,
            BrowserQuery::InitScript {
                view_id: Some("browser-2".into()),
                script: "window.__rec = 1".into(),
            }
        );
        assert_eq!(r.query.op_name(), "init_script");

        // view_id 缺省 → None（由执行体解析，不在解析层猜）
        let r = parse_browser_query(&json!({
            "type": "browser_query", "request_id": "r2", "op": "init_script", "script": "1"
        }))
        .unwrap();
        assert_eq!(
            r.query,
            BrowserQuery::InitScript {
                view_id: None,
                script: "1".into()
            }
        );
    }

    /// 载荷不合法 → `Malformed` 而**不是** `None`：必须回错误让 sidecar 立刻失败，
    /// 干等超时会把一个协议 bug 伪装成"浏览器没响应"。
    #[test]
    fn malformed_payloads_surface_instead_of_being_dropped() {
        for bad in [
            json!({"type": "browser_query", "request_id": "r", }), // 缺 op
            json!({"type": "browser_query", "request_id": "r", "op": "nope"}), // 未知 op
            json!({"type": "browser_query", "request_id": "r", "op": "eval"}), // 缺 script
            json!({"type": "browser_query", "request_id": "r", "op": "call_cdp"}), // 缺 method
            json!({"type": "browser_query", "request_id": "r", "op": "init_script"}), // 缺 script
        ] {
            match parse_browser_query(&bad).map(|r| r.query) {
                Some(BrowserQuery::Malformed(_)) => {}
                other => panic!("expected Malformed for {bad}, got {other:?}"),
            }
        }
    }

    /// call_cdp 的 params 缺省成 Null（CDP 有些方法不需要参数），不算 Malformed。
    #[test]
    fn call_cdp_without_params_defaults_to_null() {
        let r = parse_browser_query(&json!({
            "type": "browser_query", "request_id": "r", "op": "call_cdp", "method": "Browser.getVersion"
        }))
        .unwrap();
        assert_eq!(
            r.query,
            BrowserQuery::CallCdp {
                view_id: None,
                method: "Browser.getVersion".into(),
                params: Value::Null,
            }
        );
    }

    #[test]
    fn build_result_command_tags_cmd_and_request_id() {
        let v = build_result_command("r9", ok_payload(json!({"views": []})));
        assert_eq!(v["cmd"], "browser_result");
        assert_eq!(v["request_id"], "r9");
        assert_eq!(v["ok"], true);
        assert_eq!(v["data"]["views"], json!([]));

        let v = build_result_command("r10", err_payload("boom"));
        assert_eq!(v["cmd"], "browser_result");
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"], "boom");
    }

    /// 回包必须**恰好**打上本桥的 cmd 标——错成 codegraph_result 会让 sidecar 配对失败且无提示。
    #[test]
    fn result_tag_does_not_collide_with_codegraph() {
        let v = build_result_command("r", ok_payload(Value::Null));
        assert_ne!(v["cmd"], "codegraph_result");
    }
}
