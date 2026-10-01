//! `browser_query` 的**执行体**：把 sidecar 的 op 翻成门面调用，结果经 stdin 回写。
//!
//! **为什么单独一个文件**：`runtime/mod.rs` 已 928 行，内联这段会撞项目「源文件超 1000 行必须拆」
//! 的红线。这里也是唯一能同时拿到 `AppHandle`（取门面）与 stdin 回写通道的地方。
//!
//! **职责边界**：门面只认 id，**不认识「当前该操作哪个视图」**——`view_id` 解析是**策略**，
//! 住在这一层（机制/用途分离，同 CLAUDE.md 的机制/策略边界）。
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
use crate::browser::dto::{BoundsDto, BrowserViewDto, CreateBrowserDto, NavStateDto, OriginDto};
use crate::browser::facade::{BrowserFacade, FacadeError};

/// 本机 Host 的 agent 用哪个窗口的浏览器：主窗口（本机 Host 只连主窗口）。远程 Host 的 agent
/// 用连着那台 Host 的窗口（`host_window::answer_browser_query`）。**窗口选择是策略，住在调用方**。
pub const LOCAL_WINDOW: &str = "main";

/// 执行一条浏览器查询并回写结果（本机 Host：经 runtime 的 stdin）。
pub async fn handle(
    app: AppHandle,
    window: &str,
    stdin: Arc<TokioMutex<ChildStdin>>,
    req: BrowserQueryRequest,
) {
    let payload = answer(&app, window, req).await;
    if let Ok(mut line) = serde_json::to_string(&payload) {
        line.push('\n');
        let mut guard = stdin.lock().await;
        let _ = guard.write_all(line.as_bytes()).await;
    }
}

/// 在 `window` 的浏览器里执行一条查询，返回**已打好 `browser_result` 标**的回包命令。
/// 回包怎么送回 agent 由调用方定（本机 = stdin，远程 Host = `agent_tool_result`）。
pub async fn answer(app: &AppHandle, window: &str, req: BrowserQueryRequest) -> Value {
    // 可观测性：桥被拦截后既不转发前端也不回任何 UI，没有这行就只剩「成功或 15s 超时」两种
    // 可见状态，出错时无从定位（2026-09-16 实测踩过：只能靠行为反推链路是否真通）。
    let op = req.query.op_name();
    let request_id = req.request_id.clone();
    let body = run(app, window, req.query).await;

    if body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        tracing::info!(op, %request_id, window, "browser bridge: replied ok");
    } else {
        let error = body.get("error").and_then(|v| v.as_str()).unwrap_or("");
        tracing::warn!(op, %request_id, window, error, "browser bridge: replied with error");
    }
    build_result_command(&req.request_id, body)
}

/// op → 执行体，并把整段折成 stdin 回包体。
async fn run(app: &AppHandle, window: &str, query: BrowserQuery) -> Value {
    // 门面调用会在**调用线程**上等 COM 回调（线程契约见 `adapter/webview2/native.rs`），
    // 故整体收进 `spawn_blocking`——既不占 tokio 核心 worker，也不在主线程上阻塞。
    // （澄清：设计文档说的「禁止对这些 COM 调用 spawn_blocking」指的是**绕开 `with_webview`
    //   直接在池线程发 COM 调用**；编组由 `with_webview` 自己做，与调用方线程无关。）
    let app = app.clone();
    let window = window.to_string();
    match tokio::task::spawn_blocking(move || exec(&app, &window, query)).await {
        Ok(body) => body,
        // 执行体 panic：如实回错误而不是让 sidecar 干等超时。
        Err(e) => err_payload(format!("browser executor panicked: {e}")),
    }
}

/// 同步执行体（跑在 blocking 线程上）。
fn exec(app: &AppHandle, window: &str, query: BrowserQuery) -> Value {
    let facade = BrowserFacade::new(app, window);

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

        BrowserQuery::InitScript { view_id, script } => {
            let id = match resolve_view(&facade, view_id.as_deref()) {
                Ok(id) => id,
                Err(message) => return err_payload(message),
            };
            // `registered` 而不是 "installed"：这只把脚本挂到**将来**的文档上，当前这份文档
            // 不会补装上（调用方自己补）。措辞不许越界承诺。
            match facade.add_init_script(&id, &script) {
                Ok(()) => ok_payload(serde_json::json!({ "view_id": id, "registered": true })),
                Err(e) => err_payload(format!("cannot register an init script for view {id}: {e}")),
            }
        }

        BrowserQuery::Focus { view_id } => {
            let id = match resolve_view(&facade, view_id.as_deref()) {
                Ok(id) => id,
                Err(message) => return err_payload(message),
            };
            match facade.request_focus(&id) {
                // `requested` 而不是 `displayed`：面板收到事件才会切，这里只保证请求发出去了。
                Ok(()) => ok_payload(serde_json::json!({ "view_id": id, "requested": true })),
                Err(e) => err_payload(format!("cannot request focus for view {id}: {e}")),
            }
        }

        BrowserQuery::Open {
            url,
            label,
            init_script,
        } => {
            let dto = CreateBrowserDto {
                url,
                // 默认视口是**策略**（门面不认识"默认多大"）：parked 期间页面按这个宽度布局，
                // 用户切过去看时会响应式重排一次——spec 记为已知代价。
                bounds: BoundsDto {
                    x: 0.0,
                    y: 0.0,
                    w: DEFAULT_VIEW_W,
                    h: DEFAULT_VIEW_H,
                },
                displayed: Some(false), // parked：后台干活，不抢用户前台
                label,
                origin: Some(OriginDto::Agent),
                // 直通给引擎：**首次导航之前**注册（这样第一份文档从首个请求起就被覆盖）。
                init_script,
            };
            match facade.create(&dto) {
                Ok(view) => ok_payload(serde_json::json!({ "view_id": view.id, "view": view })),
                Err(e) => err_payload(format!("cannot open a browser view: {e}")),
            }
        }

        BrowserQuery::Close { view_id } => {
            let id = match resolve_view(&facade, view_id.as_deref()) {
                Ok(id) => id,
                Err(message) => return err_payload(message),
            };
            match facade.close(&id) {
                Ok(()) => ok_payload(serde_json::json!({ "view_id": id, "closed": true })),
                Err(e) => err_payload(format!("cannot close view {id}: {e}")),
            }
        }

        BrowserQuery::Navigate { view_id, url } => {
            let id = match resolve_view(&facade, view_id.as_deref()) {
                Ok(id) => id,
                Err(message) => return err_payload(message),
            };
            match facade.navigate(&id, &url) {
                Ok(view) => ok_payload(serde_json::json!({ "view_id": id, "view": view })),
                Err(e) => err_payload(format!("cannot navigate view {id}: {e}")),
            }
        }

        BrowserQuery::Back { view_id } => {
            move_in_history(&facade, view_id, "back", BrowserFacade::go_back)
        }
        BrowserQuery::Forward { view_id } => {
            move_in_history(&facade, view_id, "forward", BrowserFacade::go_forward)
        }
    }
}

/// agent 建视图的默认视口（**策略**：门面不认识"默认多大"）。
/// parked 期间页面按这个宽度布局；用户切过去看时会响应式重排一次（spec 记为已知代价）。
const DEFAULT_VIEW_W: f64 = 1280.0;
const DEFAULT_VIEW_H: f64 = 800.0;

/// 前进/后退共用的外壳：解析 id → 移动游标 → 回快照。两边只有方向不同。
fn move_in_history(
    facade: &BrowserFacade,
    view_id: Option<String>,
    direction: &str,
    step: fn(&BrowserFacade, &str) -> Result<BrowserViewDto, FacadeError>,
) -> Value {
    let id = match resolve_view(facade, view_id.as_deref()) {
        Ok(id) => id,
        Err(message) => return err_payload(message),
    };
    match step(facade, &id) {
        Ok(view) => ok_payload(serde_json::json!({ "view_id": id, "view": view })),
        Err(e) => err_payload(format!("cannot go {direction} in view {id}: {e}")),
    }
}

/// 解析要操作的视图 id（**策略层**，门面不参与）。
fn resolve_view(facade: &BrowserFacade, want: Option<&str>) -> Result<String, String> {
    let views = facade
        .list_views()
        .map_err(|e| format!("cannot list browser views: {e}"))?;
    resolve_from(&views, want)
}

/// 解析规则本体（取列表的依赖抽成参数，四条规则才好单测）。
///
/// 缺省**不猜**，歧义时如实报错并给出清单让 agent 自己选：
/// 1. 显式给了 `view_id` → 必须存在；
/// 2. 缺省 + 全库**恰好一个**视图 → 用它（单 agent 的常态）；
/// 3. 缺省 + 一个都没有 → 报错，并引导怎么开一个；
/// 4. 其余 → 报错 + 全量清单（带 label 与 displayed/parked）。
///
/// ⚠️ 旧的"缺省 + 恰一个**可见**视图 → 用它"**已去掉**：多 agent 下它会静默落到
/// **用户正看着的那个 tab**（或另一个 agent 的 tab）上——错目标的静默故障比报错坏得多。
fn resolve_from(views: &[BrowserViewDto], want: Option<&str>) -> Result<String, String> {
    if let Some(want) = want {
        return if views.iter().any(|v| v.id == want) {
            Ok(want.to_string())
        } else {
            Err(format!(
                "browser view `{want}` not found. open views: {}",
                summarise(views)
            ))
        };
    }

    if views.is_empty() {
        return Err(
            "no embedded browser view is open — open one in the browser panel first, or create \
             one with `browser_tab` (action=open)."
                .into(),
        );
    }
    if let [only] = views {
        return Ok(only.id.clone());
    }

    Err(format!(
        "{} browser views are open — pass `view_id` explicitly (the view you opened is the id \
         that `browser_tab` returned when you opened it). open views: {}",
        views.len(),
        summarise(views)
    ))
}

/// 视图清单摘要（错误文案里给 agent 挑 id 用）：
/// `browser-2 "vue-admin dev" http://localhost:5173 (parked); browser-1 https://… (displayed)`
///
/// **label 是关键**：三个 tab 挂同一个 dev server 时 URL 与标题完全一样，只有 label 分得开。
fn summarise(views: &[BrowserViewDto]) -> String {
    views
        .iter()
        .map(|v| {
            let label = v
                .label
                .as_deref()
                .map(|l| format!("\"{l}\" "))
                .unwrap_or_default();
            let state = if v.displayed { "displayed" } else { "parked" };
            format!("{} {label}{} ({state})", v.id, url_of(v))
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

    /// 给夹具补个 label（agent 建的 tab 会带名字）。
    fn labelled(mut v: BrowserViewDto, label: &str) -> BrowserViewDto {
        v.label = Some(label.into());
        v
    }

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
            label: None,
            origin: OriginDto::User,
        }
    }

    /// `summarise` 是错误文案的唯一内容来源——agent 靠它挑 id，形状错了就是选错视图。
    /// 带 label 与 displayed/parked：三个 tab 挂同一个 dev server 时，URL 分不出来。
    #[test]
    fn summarise_shows_id_label_url_and_display_state() {
        let views = vec![
            view("browser-1", true, Some("https://a.example/x")),
            labelled(view("browser-2", false, None), "vue-admin dev"),
        ];
        let s = summarise(&views);
        assert!(s.contains("browser-1 https://a.example/x (displayed)"), "{s}");
        assert!(
            s.contains("browser-2 \"vue-admin dev\" (not navigated yet) (parked)"),
            "{s}"
        );
    }

    /// 收紧后的缺省解析：**多视图一律要求显式 `view_id`**。
    /// 旧规则"缺省 + 恰一个可见视图 → 用它"在多 agent 下会让 A 的调用落到**用户正看的那个 tab**。
    #[test]
    fn default_view_resolution_requires_a_single_view() {
        assert!(resolve_from(
            &[
                view("browser-1", true, Some("http://a/")),
                view("browser-2", false, Some("http://a/")),
                view("browser-3", false, Some("http://a/")),
            ],
            None
        )
        .is_err());

        // 恰好一个视图 → 用它（单 agent 的常态）
        assert_eq!(
            resolve_from(&[view("browser-1", false, Some("http://a/"))], None).unwrap(),
            "browser-1"
        );

        // 一个都没有 → 报错里要引导怎么开
        let err = resolve_from(&[], None).unwrap_err();
        assert!(err.contains("no embedded browser view is open"), "{err}");

        // 显式 id：库里没有就报错 + 清单
        let err = resolve_from(&[view("browser-1", true, Some("http://a/"))], Some("nope"))
            .unwrap_err();
        assert!(err.contains("not found"), "{err}");
        assert!(err.contains("browser-1"), "{err}");
    }

    #[test]
    fn url_of_covers_every_nav_state() {
        assert_eq!(url_of(&view("b", true, None)), "(not navigated yet)");
        assert_eq!(url_of(&view("b", true, Some("https://x/"))), "https://x/");
    }
}
