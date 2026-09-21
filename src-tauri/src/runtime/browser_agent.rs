//! `browser_query` 的**执行体**：把 sidecar 的 op 翻成门面调用，结果经 stdin 回写。
//!
//! **为什么单独一个文件**：`runtime/mod.rs` 已 928 行，内联这段会撞项目「源文件超 1000 行必须拆」
//! 的红线。这里也是唯一能同时拿到 `AppHandle`（取门面）与 stdin 回写通道的地方。
//!
//! **职责边界**：门面只认 id，**不认识「当前该操作哪个视图」**——`view_id` 解析是**策略**，
//! 住在这一层（机制/用途分离，同 CLAUDE.md headless 的边界口径）。
//!
//! **失败纪律**：不 panic、不静默。任何失败都折成 `{ok:false, error}` 回给 sidecar，由工具层
//! 转成模型可读文本（照 codegraph 的「失败返回文本不抛错」）。

use std::sync::Arc;

use serde_json::Value;
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;
use tokio::process::ChildStdin;
use tokio::sync::Mutex as TokioMutex;

use crate::browser::agent_bridge::{
    build_result_command, err_payload, ok_payload, BrowserQuery, BrowserQueryRequest,
};
use crate::browser::dto::{BrowserViewDto, NavStateDto};
use crate::browser::facade::BrowserFacade;

/// 执行一条浏览器查询并回写结果。
pub async fn handle(app: AppHandle, stdin: Arc<TokioMutex<ChildStdin>>, req: BrowserQueryRequest) {
    // 可观测性：桥被拦截后既不转发前端也不回任何 UI，没有这行就只剩「成功或 15s 超时」两种
    // 可见状态，出错时无从定位（2026-09-16 实测踩过：只能靠行为反推链路是否真通）。
    let op = req.query.op_name();
    let request_id = req.request_id.clone();
    let body = run(&app, req.query).await;

    if body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        tracing::info!(op, %request_id, "browser bridge: replied ok");
    } else {
        let error = body.get("error").and_then(|v| v.as_str()).unwrap_or("");
        tracing::warn!(op, %request_id, error, "browser bridge: replied with error");
    }

    let payload = build_result_command(&req.request_id, body);
    if let Ok(mut line) = serde_json::to_string(&payload) {
        line.push('\n');
        let mut guard = stdin.lock().await;
        let _ = guard.write_all(line.as_bytes()).await;
    }
}

/// op → 执行体，并把整段折成 stdin 回包体。
async fn run(app: &AppHandle, query: BrowserQuery) -> Value {
    // 门面调用会在**调用线程**上等 COM 回调（线程契约见 `adapter/webview2/native.rs`），
    // 故整体收进 `spawn_blocking`——既不占 tokio 核心 worker，也不在主线程上阻塞。
    // （澄清：设计文档说的「禁止对这些 COM 调用 spawn_blocking」指的是**绕开 `with_webview`
    //   直接在池线程发 COM 调用**；编组由 `with_webview` 自己做，与调用方线程无关。）
    let app = app.clone();
    match tokio::task::spawn_blocking(move || exec(&app, query)).await {
        Ok(body) => body,
        // 执行体 panic：如实回错误而不是让 sidecar 干等超时。
        Err(e) => err_payload(format!("browser executor panicked: {e}")),
    }
}

/// 同步执行体（跑在 blocking 线程上）。
fn exec(app: &AppHandle, query: BrowserQuery) -> Value {
    let facade = BrowserFacade::new(app);

    match query {
        BrowserQuery::Malformed(why) => {
            err_payload(format!("browser bridge received a malformed query: {why}"))
        }

        BrowserQuery::ListViews => match facade.list_views() {
            // `BrowserViewDto` 是 `Serialize`；序列化失败只可能是内部类型错了，如实报。
            Ok(views) => match serde_json::to_value(&views) {
                Ok(v) => ok_payload(serde_json::json!({ "views": v })),
                Err(e) => err_payload(format!("cannot serialise view list: {e}")),
            },
            Err(e) => err_payload(format!("cannot list browser views: {e}")),
        },

        BrowserQuery::Eval { view_id, script } => {
            let id = match resolve_view(&facade, view_id.as_deref()) {
                Ok(id) => id,
                Err(message) => return err_payload(message),
            };
            match facade.eval(&id, &script) {
                Ok(value) => ok_payload(serde_json::json!({ "view_id": id, "value": value })),
                Err(e) => err_payload(format!("eval failed on view {id}: {e}")),
            }
        }

        BrowserQuery::CallCdp {
            view_id,
            method,
            params,
        } => {
            let id = match resolve_view(&facade, view_id.as_deref()) {
                Ok(id) => id,
                Err(message) => return err_payload(message),
            };
            match facade.call_cdp(&id, &method, &params) {
                Ok(value) => ok_payload(
                    serde_json::json!({ "view_id": id, "method": method, "value": value }),
                ),
                Err(e) => err_payload(format!("cdp {method} failed on view {id}: {e}")),
            }
        }
    }
}

/// 解析要操作的视图 id（**策略层**，门面不参与）。
///
/// 规则——缺省**不猜**，歧义时如实报错并给出清单让 agent 自己选：
/// 1. 显式给了 `view_id` → 必须存在；
/// 2. 缺省 + 恰一个**可见**视图 → 用它（面板切标签走 `set_displayed`，同时至多一个可见）；
/// 3. 缺省 + 无可见但恰一个视图 → 用它（面板收起但视图保活）；
/// 4. 其余 → 报错 + 全量清单。
fn resolve_view(facade: &BrowserFacade, want: Option<&str>) -> Result<String, String> {
    let views = facade
        .list_views()
        .map_err(|e| format!("cannot list browser views: {e}"))?;

    if let Some(want) = want {
        return if views.iter().any(|v| v.id == want) {
            Ok(want.to_string())
        } else {
            Err(format!(
                "browser view `{want}` not found. open views: {}",
                summarise(&views)
            ))
        };
    }

    let displayed: Vec<&BrowserViewDto> = views.iter().filter(|v| v.displayed).collect();
    if let [only] = displayed.as_slice() {
        return Ok(only.id.clone());
    }
    if views.is_empty() {
        return Err(
            "no embedded browser view is open — open one in the browser panel first.".into(),
        );
    }
    if let [only] = views.as_slice() {
        return Ok(only.id.clone());
    }

    Err(format!(
        "{} browser views are open and none is uniquely visible — pass `view_id` explicitly. open views: {}",
        views.len(),
        summarise(&views)
    ))
}

/// 视图清单摘要（错误文案里给 agent 挑 id 用）：`browser-1 https://… (hidden); browser-2 …`
fn summarise(views: &[BrowserViewDto]) -> String {
    views
        .iter()
        .map(|v| {
            let suffix = if v.displayed { "" } else { " (hidden)" };
            format!("{} {}{suffix}", v.id, url_of(v))
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// 视图当前 URL（`Idle` 态还没导航过）。`BrowserViewDto` 不承载业务方法（dto.rs 的 M3 规矩），
/// 故读法住在这里。
fn url_of(view: &BrowserViewDto) -> &str {
    match &view.nav {
        NavStateDto::Idle => "(not navigated yet)",
        NavStateDto::Loading { url }
        | NavStateDto::Ready { url, .. }
        | NavStateDto::Failed { url, .. } => url,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::dto::BoundsDto;

    fn view(id: &str, displayed: bool, url: Option<&str>) -> BrowserViewDto {
        BrowserViewDto {
            id: id.to_string(),
            nav: match url {
                Some(u) => NavStateDto::Ready {
                    url: u.to_string(),
                    title: String::new(),
                },
                None => NavStateDto::Idle,
            },
            can_go_back: false,
            can_go_forward: false,
            bounds: BoundsDto {
                x: 0.0,
                y: 0.0,
                w: 10.0,
                h: 10.0,
            },
            displayed,
        }
    }

    /// `summarise` 是错误文案的唯一内容来源——agent 靠它挑 id，形状错了就是选错视图。
    #[test]
    fn summarise_shows_id_url_and_hidden_marker() {
        let views = vec![
            view("browser-1", true, Some("https://a.example/x")),
            view("browser-2", false, None),
        ];
        let s = summarise(&views);
        assert!(s.contains("browser-1 https://a.example/x"), "{s}");
        assert!(s.contains("browser-2 (not navigated yet) (hidden)"), "{s}");
    }

    #[test]
    fn url_of_covers_every_nav_state() {
        assert_eq!(url_of(&view("b", true, None)), "(not navigated yet)");
        assert_eq!(url_of(&view("b", true, Some("https://x/"))), "https://x/");
    }
}
