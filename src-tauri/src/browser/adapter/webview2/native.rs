//! 裸 WebView2 原生下钻层：**全仓库唯一允许 `use webview2_com` 的地方**（端口隔离红线的落点）。
//!
//! tauri 的 `Webview` 只给到 fire-and-forget 的脚本注入；带返回值要下钻到裸 `ICoreWebView2`：
//! `with_webview(|pw| pw.controller())` → `.CoreWebView2()` → `ExecuteScript` /
//! `CallDevToolsProtocolMethod`。两者都是「异步调用 + completed handler」同构形状。
//!
//! # 线程契约（**别踩，历史重灾区**）
//!
//! 1. `with_webview` 在**非主线程**调用时是 fire-and-forget：投递出去就返回，闭包稍后在 webview
//!    线程跑（`tauri-runtime-wry` 的 `send_user_message`：非主线程走 `proxy.send_event`）。
//!    本模块随后在**调用线程**上 `recv_timeout` 等结果——**所以只准从非主线程调用本模块的函数**。
//!    从主线程调用会变成闭包内联执行 + 主线程阻塞等一个只能由消息循环泵出的 COM 回调 = **自锁**。
//! 2. 闭包内**只发起调用、不等待**：投出 COM 调用就返回，结果由 completed handler 经 channel 送回。
//!    **不要**用 webview2-com 的 `wait_for_async_operation`——它内部 `wait_with_pump` 会泵消息循环，
//!    在 webview 线程上泵循环是本项目 7 月 wedge 事故的同款形状。
//! 3. 「禁止对 COM 调用 `spawn_blocking`」的准确含义是：**不许绕开 `with_webview` 直接在池线程上
//!    发 COM 调用**（会跑错线程）。把「阻塞等待」这一段放进 `spawn_blocking` 是**合法**的——
//!    编组由 `with_webview` 自己完成，与调用方线程无关。
//! 4. 结果字符串由 completed handler 在 **COM 回调线程**上送出：webview2-com 的 `PCWSTR → String`
//!    转换在回调内完成（拷贝），不持有 COM 侧指针，无生命周期问题。

use std::sync::mpsc;
use std::time::Duration;

use tauri::webview::Webview;
use tauri::Wry;
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, ExecuteScriptCompletedHandler};
use windows::core::PCWSTR;

use crate::browser::port::engine::EngineError;

/// 单次下钻调用的等待上限。
///
/// 存在理由：视图在 `handle()` 取出与闭包执行之间被 `close` 掉时，completed handler 永不来。
/// 层级：本值 < sidecar 客户端超时（15s）——保证「视图不存在」「脚本报错」这类**快错误以真实
/// 错误文本回到模型**，而不是被客户端超时笼统兜底。改这里要同时看 `browserClient.ts` 的常量。
pub const NATIVE_TIMEOUT: Duration = Duration::from_secs(10);

/// 下钻回复通道：脚本/CDP 的结果（JSON 文本）或失败原因。
type Reply = mpsc::Sender<Result<String, String>>;

/// 下钻公共骨架：编组到 webview 线程发起调用 → 等 completed handler 回话 → 解析 JSON。
///
/// `f` 在 **webview 线程**执行，**只准发起调用、不准等待**；结果必须经 `Reply` 送回。
///
/// `fail` 把「失败原因文本」映射成调用方自己的错误变体——脚本注入失败（`EvalFailed`）与
/// CDP 调用失败（`CdpFailed`）排查路径完全不同，**不许在骨架里糊成一个**。
fn drill<F>(
    wv: &Webview<Wry>,
    fail: impl Fn(String) -> EngineError,
    f: F,
) -> Result<serde_json::Value, EngineError>
where
    F: FnOnce(&ICoreWebView2, Reply) + Send + 'static,
{
    let (tx, rx) = mpsc::channel::<Result<String, String>>();

    wv.with_webview(move |pw| {
        let core = match unsafe { pw.controller().CoreWebView2() } {
            Ok(core) => core,
            Err(e) => {
                let _ = tx.send(Err(format!("CoreWebView2: {e}")));
                return;
            }
        };
        f(&core, tx);
    })
    .map_err(|e| fail(format!("with_webview: {e}")))?;

    match rx.recv_timeout(NATIVE_TIMEOUT) {
        Ok(Ok(json)) => serde_json::from_str(&json)
            .map_err(|e| fail(format!("native call returned non-JSON ({e}): {json}"))),
        Ok(Err(detail)) => Err(fail(detail)),
        // 超时原因不止一种：视图可能在取出句柄与闭包执行之间被 close（completed handler 永不来），
        // 也可能是**依赖合成帧的调用**（如 Page.captureScreenshot）落在了隐藏视图上——隐藏视图
        // 一帧都不合成，回包永远不来。下钻层是通用骨架，**只枚举可能，不指名单一原因**。
        Err(_) => Err(fail(format!(
            "native call got no reply within {NATIVE_TIMEOUT:?} (the view may be closed, or a \
             compositor-dependent call was made on a hidden view)"
        ))),
    }
}

/// UTF-16 + NUL 终止的宽字符串。
///
/// 生命周期：`ExecuteScript` / `CallDevToolsProtocolMethod` 的 `[in]` 字符串参数在**调用期间**
/// 即被 COM 侧拷贝，故缓冲区活到调用返回即可——不需要 move 进 completed 闭包。
/// （真正需要活到回调之后的是**结果**指针，那个由 webview2-com 在回调内转成 `String`。）
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 带返回值的脚本注入（WebView2 `ExecuteScript`）。
///
/// # 返回形状（**脚本契约，别绕过**）
///
/// `ExecuteScript` 把脚本结果序列化成 JSON 文本。**页面脚本抛异常时它回 `null`，与「脚本确实
/// 返回 null」不可区分**——所以经本函数执行的脚本一律返回信封 `{ok: true|false, ...}`，
/// 由调用方（sidecar 投影脚本）据此区分失败与空结果。这条不是风格问题：没有信封，
/// 「抽取失败」会被静默当成「页面是空的」。
pub fn execute_script(wv: &Webview<Wry>, script: &str) -> Result<serde_json::Value, EngineError> {
    let script = script.to_string();
    drill(wv, EngineError::EvalFailed, move |core, tx| {
        let tx_handler = tx.clone();
        let handler = ExecuteScriptCompletedHandler::create(Box::new(move |result, json| {
            let _ = tx_handler.send(match result {
                Ok(()) => Ok(json),
                Err(e) => Err(format!("ExecuteScript: {e}")),
            });
            Ok(())
        }));

        let js = wide(&script);
        // 调用期间 COM 侧即拷贝 js，故 js 活到此处即可。
        if let Err(e) = unsafe { core.ExecuteScript(PCWSTR::from_raw(js.as_ptr()), &handler) } {
            let _ = tx.send(Err(format!("ExecuteScript call: {e}")));
        }
    })
}

/// 裸 CDP 调用（WebView2 `CallDevToolsProtocolMethod`）。
///
/// 用途：`browser_act` 的真实输入事件（`Input.dispatchMouseEvent`）、文件上传
/// （`DOM.setFileInputFiles`）、以及将来订阅 `DevToolsProtocolEventReceived`。
///
/// ⚠️ **WebView2 对部分 CDP 域名有限制**（`Target.*` / `Browser.*` 一类不可用）——
/// 域名可用性是**运行期行为**，源码不可证，靠探针实测。调用方必须把失败如实上报给模型，
/// 不许静默降级假装成功。
pub fn call_cdp(
    wv: &Webview<Wry>,
    method: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, EngineError> {
    let method = method.to_string();
    let params_json = params.to_string();

    drill(wv, EngineError::CdpFailed, move |core, tx| {
        let tx_handler = tx.clone();
        let handler =
            CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
                let _ = tx_handler.send(match result {
                    Ok(()) => Ok(json),
                    Err(e) => Err(format!("CallDevToolsProtocolMethod: {e}")),
                });
                Ok(())
            }));

        let m = wide(&method);
        let p = wide(&params_json);
        let call = unsafe {
            core.CallDevToolsProtocolMethod(
                PCWSTR::from_raw(m.as_ptr()),
                PCWSTR::from_raw(p.as_ptr()),
                &handler,
            )
        };
        if let Err(e) = call {
            let _ = tx.send(Err(format!("CallDevToolsProtocolMethod call: {e}")));
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `wide` 的正确性：UTF-16 编码 + NUL 终止 + 中文不丢。
    /// （下钻本体需要真 webview，只能在端到端里验——这里只钉住唯一可纯测的部分。）
    #[test]
    fn wide_encodes_utf16_with_nul_terminator() {
        assert_eq!(wide(""), vec![0]);
        assert_eq!(wide("ab"), vec![0x61, 0x62, 0]);
        // 中文落在 BMP 内：单 u16 码元
        assert_eq!(wide("中"), vec![0x4E2D, 0]);
        // 非 BMP（emoji）：代理对，两个码元
        assert_eq!(wide("😀"), vec![0xD83D, 0xDE00, 0]);
    }

    #[test]
    fn wide_output_is_nul_terminated_for_any_input() {
        for s in ["", "x", "中文脚本", "😀🀄"] {
            assert_eq!(wide(s).last(), Some(&0), "input {s:?}");
        }
    }
}
