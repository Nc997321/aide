//! 远程车道：跑在目标机（WSL / SSH）上的 sidecar，经 `aide-host agent` 管道接入。
//!
//! 会话按工作区归属选车道：`send_message` 解析出的 cwd 是远程路径 → 该会话绑定到那台
//! 主机的车道（[`AgentRuntimeManager::bind_session_lane`]），此后同会话的所有命令
//! （permission_response / interrupt / set_model …）由 `send_to_runtime` 按绑定路由。
//! 事件泵与本机车道是同一条（见 `pump.rs`），前端看到的 chat-event 形状完全一致。
//!
//! 路径两个方向：发出去的命令里桌面形态 → 目标机路径（[`translate_send_command`]）；
//! 回来的事件里目标机路径 → 桌面形态（[`map_event_paths`]）。**只动结构化字段**，
//! 不改模型输出的正文——正文里的路径由前端按会话工作区解析（见 fileMentions）。

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use aide_host::protocol::AgentInit;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex as TokioMutex;

use super::pump::{self, Lane};
use super::AgentRuntimeManager;
use crate::remote_workspace::path::{self, HostId};
use crate::remote_workspace::{install, launcher, RemoteWorkspaces};

/// 一条远程车道的进程句柄（`aide-host agent` 子进程 = wsl.exe / ssh）。
pub(super) struct RemoteLane {
    pub stdin: Arc<TokioMutex<ChildStdin>>,
    pub child: Arc<TokioMutex<Child>>,
    pub killed: Arc<AtomicBool>,
    /// 桌面回环代理在目标机上的改写主机（见 `install::loopback_host_for`）；None = 丢弃。
    pub loopback_host: Option<String>,
}

/// 事件里承载路径的字段名（sidecar 事件 + 工具输入）。值是字符串或字符串数组。
const PATH_KEYS: &[&str] = &[
    "file_path",
    "notebook_path",
    "path",
    "cwd",
    "outputFile",
    "dirs",
    "rejected",
];

/// 桌面 → 目标机：翻译一条 send 命令（cwd / @引用展开后的 prompt / 附加目录）。
/// `display` 不动——它是渲染描述，原样广播回各端，里面必须保持桌面形态。
pub fn translate_send_command(host: &HostId, cmd: &mut Value, loopback_host: Option<&str>) {
    if let Some(cwd) = cmd.get("cwd").and_then(Value::as_str) {
        if let Some((_, posix)) = path::parse(cwd) {
            cmd["cwd"] = Value::String(posix);
        }
    }
    if let Some(prompt) = cmd.get("prompt").and_then(Value::as_str) {
        cmd["prompt"] = Value::String(path::translate_text_to_posix(host, prompt));
    }
    // 附加目录：同一台主机上的译成目标机路径；别处的（本机 / 其它主机）目标机看不见，
    // 挪进 attach_rejected 回声——前端照常显示「已忽略」，不静默丢。
    // attach_rejected 本身是给人看的回声，保持桌面形态。
    if let Some(arr) = cmd.get("additional_dirs").and_then(Value::as_array).cloned() {
        let mut accepted = Vec::new();
        let mut foreign = Vec::new();
        for v in arr {
            match v.as_str().and_then(path::parse) {
                Some((h, posix)) if &h == host => accepted.push(Value::String(posix)),
                _ => foreign.push(v),
            }
        }
        cmd["additional_dirs"] = Value::Array(accepted);
        if !foreign.is_empty() {
            let mut rejected = cmd
                .get("attach_rejected")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            rejected.extend(foreign);
            cmd["attach_rejected"] = Value::Array(rejected);
        }
    }
    rewrite_loopback_proxies(host, cmd, loopback_host);
    // 代码索引在桌面进程里，看不到目标机的文件：远程会话不挂它。LSP 不同——语言服务器经
    // `aide-host lsp` 跑在目标机上，`lsp_languages` 由 send 路径按目标机探测结果给出，原样放行。
    cmd["codegraph_enabled"] = Value::Bool(false);
}

const PROXY_KEYS: &[&str] = &[
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
];

/// 桌面的回环代理（`http://127.0.0.1:7890`）在目标机上指向目标机自己。WSL 改写成目标机
/// 能到达桌面的地址（mirrored 模式保持回环 / NAT 模式换成 Windows 主机），SSH 丢弃——
/// 丢弃后目标机登录环境里自己的代理生效（WSL 用户常在 rc 里配 Windows 主机 IP）。
fn rewrite_loopback_proxies(host: &HostId, cmd: &mut Value, loopback_host: Option<&str>) {
    let Some(env) = cmd.get_mut("env").and_then(Value::as_object_mut) else {
        return;
    };
    for key in PROXY_KEYS {
        let Some(url) = env.get(*key).and_then(Value::as_str).map(String::from) else {
            continue;
        };
        let loopback = install::proxy_host_port(&url).is_some_and(|(h, _)| install::is_loopback_host(&h));
        if !loopback {
            continue;
        }
        match loopback_host {
            Some(h) => {
                env.insert((*key).to_string(), Value::String(install::replace_proxy_host(&url, h)));
            }
            None => {
                tracing::info!(host = %host, key, "remote lane: dropped desktop loopback proxy");
                env.remove(*key);
            }
        }
    }
}

/// 目标机 → 桌面：事件结构化字段里的绝对路径译回桌面形态。
pub fn map_event_paths(host: &HostId, v: &mut Value) {
    match v {
        Value::Object(o) => {
            for (k, val) in o.iter_mut() {
                if PATH_KEYS.contains(&k.as_str()) {
                    match val {
                        Value::String(s) if s.starts_with('/') => {
                            *s = path::to_desktop(host, s);
                        }
                        Value::Array(a) => {
                            for item in a.iter_mut() {
                                if let Value::String(s) = item {
                                    if s.starts_with('/') {
                                        *s = path::to_desktop(host, s);
                                    }
                                }
                            }
                        }
                        other => map_event_paths(host, other),
                    }
                } else {
                    map_event_paths(host, val);
                }
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|x| map_event_paths(host, x)),
        _ => {}
    }
}

/// codegraph 桥查询：远程工作区不支持，就地回错误结果。返回 true = 已处理。
/// （LSP 桥**支持**：语言服务器经 `aide-host lsp` 跑在目标机上，见 `runtime::lsp_agent`。）
pub(super) async fn answer_unsupported_bridge(
    event: &Value,
    host: &HostId,
    stdin: &Arc<TokioMutex<ChildStdin>>,
) -> bool {
    let reply = if let Some(req) = crate::codegraph::agent_bridge::parse_codegraph_query(event) {
        crate::codegraph::agent_bridge::build_result_command(
            &req.request_id,
            serde_json::json!({
                "ok": false, "status": "error",
                "error": format!("代码索引暂不支持远程工作区（{}）", host.label()),
            }),
        )
    } else {
        return false;
    };
    if let Ok(mut line) = serde_json::to_string(&reply) {
        line.push('\n');
        let _ = stdin.lock().await.write_all(line.as_bytes()).await;
    }
    true
}

/// 车道进程死亡：只给绑在这条车道上的会话发 `session_dead`（前端据此把会话置为
/// 可重发；下一条 send 会重建车道）。本机车道与其它主机的会话不受影响。
pub(super) fn on_lane_dead(
    app: &AppHandle,
    host: &HostId,
    tail: &Arc<Mutex<VecDeque<String>>>,
    reason: &str,
) {
    let detail: Vec<String> = tail.lock().unwrap().iter().cloned().collect();
    let detail = (!detail.is_empty()).then(|| detail.join("\n"));
    tracing::warn!(host = %host, reason, ?detail, "remote agent lane died");
    let Some(mgr) = app.try_state::<AgentRuntimeManager>() else {
        return;
    };
    let sessions = mgr.drop_lane(host);
    for sid in sessions {
        mgr.mark_session_dead(&sid);
        let _ = app.emit(
            "chat-event",
            serde_json::json!({
                "type": "session_dead",
                "session_id": sid,
                "reason": if reason == "heartbeat_timeout" { "heartbeat_timeout" } else { "exit" },
                "detail": detail.clone().unwrap_or_else(|| format!("与 {} 的 agent 连接已断开", host.label())),
            }),
        );
    }
}

impl AgentRuntimeManager {
    /// 会话绑定到远程车道（`send_message` 在发出前调用）。
    pub fn bind_session_lane(&self, session_id: &str, host: &HostId) {
        self.session_lanes
            .lock()
            .unwrap()
            .insert(session_id.to_string(), host.clone());
    }

    pub fn lane_of(&self, session_id: &str) -> Option<HostId> {
        self.session_lanes.lock().unwrap().get(session_id).cloned()
    }

    /// 摘掉一条车道，返回曾绑在它上面的会话。
    pub(super) fn drop_lane(&self, host: &HostId) -> Vec<String> {
        self.remote_lanes.lock().unwrap().remove(host);
        let mut lanes = self.session_lanes.lock().unwrap();
        let sids: Vec<String> = lanes
            .iter()
            .filter(|(_, h)| *h == host)
            .map(|(s, _)| s.clone())
            .collect();
        for s in &sids {
            lanes.remove(s);
        }
        sids
    }

    /// 翻译一条发往远程车道的 send（路径 + 代理改写，见 [`translate_send_command`]）。
    pub fn translate_for_lane(&self, host: &HostId, cmd: &mut Value) {
        let loopback = self
            .remote_lanes
            .lock()
            .unwrap()
            .get(host)
            .and_then(|l| l.loopback_host.clone());
        translate_send_command(host, cmd, loopback.as_deref());
    }

    pub(super) fn remote_lane_stdin(&self, host: &HostId) -> Option<Arc<TokioMutex<ChildStdin>>> {
        self.remote_lanes
            .lock()
            .unwrap()
            .get(host)
            .map(|l| Arc::clone(&l.stdin))
    }

    /// 幂等地拉起一台主机的 agent 车道（必要时先安装远程套件）。
    pub async fn ensure_remote_lane(&self, app: &AppHandle, host: &HostId) -> Result<(), String> {
        if self.remote_lanes.lock().unwrap().contains_key(host) {
            return Ok(());
        }
        // 安装（首次可能几十秒）在拿启动锁**之前**：锁与本机 Runtime 冷启动共用，
        // 不能让一次远程安装卡住本机会话的启动。安装自身由 RemoteWorkspaces 单飞。
        let svc = app
            .try_state::<Arc<RemoteWorkspaces>>()
            .ok_or("remote workspaces not initialised")?
            .inner()
            .clone();
        let installed = svc.installed(host).await?;
        let _spawn_guard = self.spawn_lock.lock().await;
        if self.remote_lanes.lock().unwrap().contains_key(host) {
            return Ok(());
        }

        let script = format!("exec {} agent", launcher::sh_quote(&installed.host_bin));
        let mut cmd = launcher::command(host, &script)?;
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("无法在 {} 上启动 agent：{e}", host.label()))?;
        let mut stdin = child.stdin.take().ok_or("No stdin")?;
        let stdout = child.stdout.take().ok_or("No stdout")?;
        let stderr = child.stderr.take().ok_or("No stderr")?;

        // 首行 AgentInit：进程级 env 走 stdin（命令行在目标机 ps 里全员可见）。
        // 连接凭据不在这里——它们随每条 send 的 env 下发，与本机车道同一路径。
        let mut env = HashMap::new();
        env.insert("AIDE_CLAUDE_EXE".to_string(), installed.claude_exe.clone());
        env.extend(tool_switches(|k| std::env::var(k).ok()));
        // 代理：桌面探测到的代理（设置 → 环境 → git → 常见本地端口）作**兜底**下发——目标机
        // 登录环境里已有代理就用它自己的。回环地址按目标机网络改写（见 loopback_host_for）。
        let desktop_proxy = tokio::task::spawn_blocking(crate::commands::proxy::detect_proxy)
            .await
            .ok()
            .flatten();
        let mut default_env = HashMap::new();
        let mut loopback_host = None;
        if let Some(url) = desktop_proxy {
            if let Some((h, port)) = install::proxy_host_port(&url) {
                let target_url = if install::is_loopback_host(&h) {
                    loopback_host = install::loopback_host_for(host, &installed, port).await;
                    loopback_host.as_deref().map(|lh| install::replace_proxy_host(&url, lh))
                } else {
                    Some(url.clone())
                };
                if let Some(u) = target_url {
                    tracing::info!(host = %host, proxy = %u, "remote lane: default proxy");
                    for k in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
                        default_env.insert(k.to_string(), u.clone());
                    }
                }
            }
        }
        let init = AgentInit {
            env,
            default_env,
            node: installed.node.clone(),
            runtime: None,
        };
        let mut line = serde_json::to_string(&init).map_err(|e| e.to_string())?;
        line.push('\n');
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("agent 初始化写入失败：{e}"))?;

        let lane = RemoteLane {
            stdin: Arc::new(TokioMutex::new(stdin)),
            child: Arc::new(TokioMutex::new(child)),
            killed: Arc::new(AtomicBool::new(false)),
            loopback_host,
        };
        pump::start(pump::Pump {
            app: app.clone(),
            lane: Lane::Remote(host.clone()),
            stdout,
            stderr,
            stdin: Arc::clone(&lane.stdin),
            child: Arc::clone(&lane.child),
            killed: Arc::clone(&lane.killed),
            chat_events: self.chat_events.clone(),
        });
        self.remote_lanes.lock().unwrap().insert(host.clone(), lane);
        Ok(())
    }

    /// 杀掉全部远程车道（app 退出）。
    pub(super) async fn kill_remote_lanes(&self) {
        let lanes: Vec<RemoteLane> = self.remote_lanes.lock().unwrap().drain().map(|(_, l)| l).collect();
        for l in lanes {
            l.killed.store(true, std::sync::atomic::Ordering::Relaxed);
            let _ = l.child.lock().await.start_kill();
        }
    }
}

/// 桌面进程环境里的工具开关（`AIDE_LSP_TOOLS=off` 这类逃生舱）原样带到目标机。
///
/// 本机车道的 sidecar 继承桌面进程环境，开关天然生效；远程车道的 runtime 起在目标机上，
/// 环境只有 AgentInit 递过去的这些——不带过去，用户关掉的工具在 WSL / SSH 工作区里照样挂着
/// （2026-09-30 真机：设了 `AIDE_LSP_TOOLS=off` 的对照轮里 aide-lsp 仍在）。
const TOOL_SWITCHES: &[&str] = &[
    "AIDE_LSP_TOOLS",
    "AIDE_CODEGRAPH_TOOLS",
    "AIDE_DOCX_TOOLS",
    "AIDE_KB_TOOLS",
    "AIDE_BROWSER_TOOLS",
];

fn tool_switches(get: impl Fn(&str) -> Option<String>) -> HashMap<String, String> {
    TOOL_SWITCHES
        .iter()
        .filter_map(|k| get(k).map(|v| (k.to_string(), v)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn host() -> HostId {
        HostId::Wsl("Debian".into())
    }

    #[test]
    fn send_command_translation() {
        let mut cmd = json!({
            "cmd": "send",
            "cwd": "\\\\wsl.localhost\\Debian\\home\\u\\p",
            "prompt": "看看 \\\\wsl.localhost\\Debian\\home\\u\\p\\src\\a.rs",
            "additional_dirs": ["\\\\wsl.localhost\\Debian\\home\\u\\lib", "C:\\local"],
            "display": {"blocks": [{"path": "\\\\wsl.localhost\\Debian\\home\\u\\p\\src\\a.rs"}]},
            "codegraph_enabled": true,
        });
        translate_send_command(&host(), &mut cmd, None);
        assert_eq!(cmd["cwd"], "/home/u/p");
        assert_eq!(cmd["prompt"], "看看 /home/u/p/src/a.rs");
        assert_eq!(cmd["additional_dirs"], json!(["/home/u/lib"]));
        assert_eq!(cmd["attach_rejected"], json!(["C:\\local"]));
        // display 保持桌面形态（渲染描述原样回灌各端）
        assert_eq!(cmd["display"]["blocks"][0]["path"], "\\\\wsl.localhost\\Debian\\home\\u\\p\\src\\a.rs");
        assert_eq!(cmd["codegraph_enabled"], false);
        assert!(cmd.get("lsp_languages").is_none(), "LSP 语言表由 send 路径给，车道不改写");
    }

    #[test]
    fn event_paths_mapped_back_but_text_untouched() {
        let mut ev = json!({
            "type": "tool_use_start",
            "input": {"file_path": "/home/u/p/a.rs", "content": "/home/u/p/a.rs"},
            "dirs": ["/home/u/lib"],
            "text": "/home/u/p",
        });
        map_event_paths(&host(), &mut ev);
        assert_eq!(ev["input"]["file_path"], "\\\\wsl.localhost\\Debian\\home\\u\\p\\a.rs");
        assert_eq!(ev["input"]["content"], "/home/u/p/a.rs");
        assert_eq!(ev["dirs"][0], "\\\\wsl.localhost\\Debian\\home\\u\\lib");
        assert_eq!(ev["text"], "/home/u/p");
    }

    #[test]
    fn tool_switches_travel_to_the_target() {
        let env = tool_switches(|k| (k == "AIDE_LSP_TOOLS").then(|| "off".to_string()));
        assert_eq!(env.len(), 1);
        assert_eq!(env["AIDE_LSP_TOOLS"], "off");
    }

    fn proxy_env() -> Value {
        json!({"env": {
            "HTTPS_PROXY": "http://127.0.0.1:7890",
            "http_proxy": "http://user:pw@localhost:8080",
            "HTTP_PROXY": "http://10.0.0.5:3128",
            "ANTHROPIC_API_KEY": "k",
        }})
    }

    #[test]
    fn loopback_proxies_dropped_without_rewrite_target() {
        let mut cmd = proxy_env();
        translate_send_command(&HostId::Ssh("box".into()), &mut cmd, None);
        assert_eq!(cmd["env"], json!({"HTTP_PROXY": "http://10.0.0.5:3128", "ANTHROPIC_API_KEY": "k"}));
    }

    #[test]
    fn loopback_proxies_rewritten_for_wsl_nat() {
        let mut cmd = proxy_env();
        translate_send_command(&host(), &mut cmd, Some("172.20.192.1"));
        assert_eq!(cmd["env"]["HTTPS_PROXY"], "http://172.20.192.1:7890");
        assert_eq!(cmd["env"]["http_proxy"], "http://user:pw@172.20.192.1:8080");
        assert_eq!(cmd["env"]["HTTP_PROXY"], "http://10.0.0.5:3128");
    }

    #[test]
    fn relative_path_fields_untouched() {
        let mut ev = json!({"input": {"path": "src"}});
        map_event_paths(&host(), &mut ev);
        assert_eq!(ev["input"]["path"], "src");
    }
}
