//! 暴露目录：**手机能对 Host 调什么、能收什么事件**——整张表就是远程暴露面，读这个文件即可审计。
//!
//! 方法名 = Host 命令表（`aide-core` 的 registry）里的命令名，参数 / 结果形状与桌面前端 invoke
//! 完全一致（Aide Link 只是命令表的又一扇前门，不另造一套命令）。本表只回答「哪些命令对远程
//! 开放」，按**组**归类（组是给人看的、也是将来按设备收窄授权的粒度）。
//!
//! 收录原则：共享聊天闭包（@aide/sdk）被动调用 + 手机 UI 必需。桌面 UI 专属动作（定制项 CRUD、
//! 终端、文件写入、git、打开方式…）不收录。新增 = 这里加一行 + 文档目录同步 + 一致性用例。
//!
//! 「默认值」类的远程专属行为（`send_message` 缺 `permissionMode` 时用 Host 的远程默认）也在这里
//! 以 [`Catalog::prepare`] 声明，不散落在传输层。

use serde::Serialize;
use serde_json::{json, Value};

/// 一组方法。
pub struct Group {
    pub id: &'static str,
    pub title: &'static str,
    pub methods: &'static [&'static str],
}

/// 可订阅的事件。
pub struct EventSpec {
    pub name: &'static str,
    /// payload 里带 `session_id`，受 `subscribe.sessions` 过滤。
    pub session_routed: bool,
}

pub static GROUPS: &[Group] = &[
    Group {
        id: "chat",
        title: "聊天控制",
        methods: &[
            "send_message",
            "permission_response",
            "interrupt_session",
            "stop_chat_session",
            "stop_bg_task",
            "set_model",
            "set_effort",
            "set_permission_mode",
            "btw_ask",
            "get_default_models",
            "get_default_permission_modes",
        ],
    },
    Group {
        id: "sessions",
        title: "会话与元数据",
        methods: &[
            "list_sessions",
            "list_sessions_for_workspace",
            "create_session",
            "delete_session",
            "rename_session",
            "auto_rename_session",
            "load_messages",
            "session_last_event",
            "session_model",
            "session_effort",
            "session_provider",
            "session_workspace",
            "set_session_workspace",
            "session_identity_drift",
            "set_session_meta",
            "session_alive",
            "list_bg_tasks",
        ],
    },
    Group {
        id: "workspace",
        title: "工作区",
        methods: &[
            "list_workspaces",
            "daily_workspace",
            "get_active_workspace",
            "is_workspace_trusted",
            "trust_workspace",
            "untrust_workspace",
        ],
    },
    Group {
        id: "settings",
        title: "设置与供应商",
        methods: &[
            "get_settings",
            "set_settings",
            "get_providers",
            "set_providers",
            "get_active_provider_id",
            "set_active_provider_id",
            "get_provider_catalog",
            "refresh_models",
            "claude_credentials_exist",
            "load_notifications",
            "save_notifications",
        ],
    },
    Group {
        id: "automation",
        title: "自动化任务",
        methods: &[
            "list_automations",
            "get_automation",
            "create_automation",
            "update_automation",
            "delete_automation",
            "set_automation_enabled",
            "list_automation_runs",
            "automation_run_stats",
            "run_automation_now",
            "get_automation_playbook",
            "redistill_automation",
        ],
    },
];

pub static EVENTS: &[EventSpec] = &[
    EventSpec { name: "chat-event", session_routed: true },
    EventSpec { name: "system-notification", session_routed: false },
    EventSpec { name: "permissions-changed", session_routed: false },
];

/// 协议自己的方法（不转给 Host，由连接会话直接处理），命名空间 `link.`。
pub const LINK_DESCRIBE: &str = "link.describe";
pub const LINK_UNPAIR: &str = "link.unpair";

/// 对远程客户端生效的 Host 策略（由 Host 一侧的设置给）。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LinkPolicy {
    /// 手机发 `send_message` 不带 `permissionMode` 时用的权限模式。
    pub permission_mode: String,
}

impl Default for LinkPolicy {
    fn default() -> Self {
        Self { permission_mode: "manual".into() }
    }
}

pub struct Catalog;

impl Catalog {
    /// 方法所属的组；不在目录里 = 不可调。
    pub fn group_of(method: &str) -> Option<&'static str> {
        GROUPS.iter().find(|g| g.methods.contains(&method)).map(|g| g.id)
    }

    pub fn is_event_exposed(name: &str) -> bool {
        EVENTS.iter().any(|e| e.name == name)
    }

    /// 全部方法名（含组）。
    pub fn methods() -> impl Iterator<Item = (&'static str, &'static str)> {
        GROUPS.iter().flat_map(|g| g.methods.iter().map(move |m| (g.id, *m)))
    }

    /// 当前版本授予已配对设备的组（v1：单设备、全授；字段为将来按设备收窄预留）。
    pub fn granted() -> Vec<String> {
        GROUPS.iter().map(|g| g.id.to_string()).collect()
    }

    /// `link.describe` 的结果：机器可读目录（文档里的表只是示例，以运行时返回为准）。
    pub fn describe() -> Value {
        json!({
            "version": 1,
            "groups": GROUPS.iter().map(|g| json!({
                "id": g.id,
                "title": g.title,
                "methods": g.methods,
            })).collect::<Vec<_>>(),
            "link_methods": [LINK_DESCRIBE, LINK_UNPAIR],
            "events": EVENTS.iter().map(|e| json!({
                "name": e.name,
                "session_routed": e.session_routed,
            })).collect::<Vec<_>>(),
        })
    }

    /// 转给 Host 前的远程专属预处理。**只做「补默认 / 归一化」，不做校验**——参数形状由 Host 命令
    /// 自己校验（与桌面同一份）；这里只保证 `params` 是对象。
    pub fn prepare(method: &str, params: Value, policy: &LinkPolicy) -> Result<Value, String> {
        let mut params = match params {
            Value::Null => Value::Object(Default::default()),
            p @ Value::Object(_) => p,
            _ => return Err("params 必须是对象".into()),
        };
        if method == "send_message" {
            let given = params.get("permissionMode").and_then(Value::as_str).map(str::to_string);
            let mode = normalize_permission_mode(given.unwrap_or_else(|| policy.permission_mode.clone()));
            params["permissionMode"] = Value::String(mode);
        }
        Ok(params)
    }
}

/// 权限模式 id 迁移：`default` 已更名为 `manual`（对齐 CLI 的 `--permission-mode`）。老客户端
/// 随消息带的旧 id、Host 设置里存的旧值都要归一化，否则 sidecar 会收到清单外的模式。
fn normalize_permission_mode(mode: String) -> String {
    if mode == "default" {
        "manual".to_string()
    } else {
        mode
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一个方法只能属于一组；不能占用协议自己的 `link.` 命名空间。
    #[test]
    fn methods_are_unique_and_outside_the_link_namespace() {
        let mut seen = std::collections::HashSet::new();
        for (_, m) in Catalog::methods() {
            assert!(seen.insert(m), "{m} listed twice");
            assert!(!m.starts_with("link."), "{m} squats the protocol namespace");
        }
    }

    #[test]
    fn group_lookup_and_unknown_methods() {
        assert_eq!(Catalog::group_of("send_message"), Some("chat"));
        assert_eq!(Catalog::group_of("list_sessions"), Some("sessions"));
        // 桌面专属的命令不对远程开放
        for m in ["write_file_content", "pty_spawn_shell", "git_status", "set_providers_secret"] {
            assert_eq!(Catalog::group_of(m), None, "{m} must not be exposed");
        }
    }

    #[test]
    fn describe_lists_every_exposed_method_and_event() {
        let d = Catalog::describe();
        let listed: usize = d["groups"].as_array().unwrap().iter().map(|g| g["methods"].as_array().unwrap().len()).sum();
        assert_eq!(listed, Catalog::methods().count());
        assert_eq!(d["events"][0]["name"], "chat-event");
        assert_eq!(d["events"][0]["session_routed"], true);
        assert!(Catalog::is_event_exposed("system-notification"));
        assert!(!Catalog::is_event_exposed("file-tree-changed"));
    }

    #[test]
    fn send_message_gets_the_host_default_permission_mode() {
        let policy = LinkPolicy { permission_mode: "acceptEdits".into() };
        let p = Catalog::prepare("send_message", json!({"sessionId":"s","prompt":"hi"}), &policy).unwrap();
        assert_eq!(p["permissionMode"], "acceptEdits");
        // 客户端自己给的优先；旧 id `default` 归一化成 `manual`
        let p = Catalog::prepare("send_message", json!({"permissionMode":"plan"}), &policy).unwrap();
        assert_eq!(p["permissionMode"], "plan");
        let p = Catalog::prepare("send_message", json!({"permissionMode":"default"}), &policy).unwrap();
        assert_eq!(p["permissionMode"], "manual");
        let policy = LinkPolicy { permission_mode: "default".into() };
        let p = Catalog::prepare("send_message", json!({}), &policy).unwrap();
        assert_eq!(p["permissionMode"], "manual");
    }

    #[test]
    fn other_methods_pass_through_and_params_must_be_an_object() {
        let policy = LinkPolicy::default();
        assert_eq!(Catalog::prepare("list_sessions", Value::Null, &policy).unwrap(), json!({}));
        assert_eq!(Catalog::prepare("list_sessions", json!({"a":1}), &policy).unwrap(), json!({"a":1}));
        assert!(Catalog::prepare("list_sessions", json!([1]), &policy).is_err());
    }
}
