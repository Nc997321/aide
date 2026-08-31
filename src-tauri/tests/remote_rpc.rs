use aide::remote::rpc;
use serde_json::json;

// ── RPC 注册表（白名单）对账 ──

#[test]
fn lookup_known_commands() {
    // 白名单核心成员抽查（聊天控制 + 会话 + 工作区 + 设置 + codegraph 各域至少一条）
    for name in [
        "send_message",
        "permission_response",
        "interrupt_session",
        "start_btw_session",
        "list_sessions",
        "load_messages",
        "list_workspaces",
        "get_settings",
        "get_providers",
        "codegraph_build_progress",
        "get_default_models",
    ] {
        assert!(rpc::lookup(name).is_some(), "白名单缺命令: {name}");
    }
}

#[test]
fn lookup_rejects_unknown_and_desktop_only_commands() {
    // 未知命令与「桌面 UI 专属」命令一律不在白名单
    for name in [
        "rm_rf",
        "delete_file",
        "write_file_content",
        "list_agents", // customizations CRUD 是桌面 UI 驱动，不进远程面
        "set_open_with_extensions",
        "install_plugin",
        "remote_revoke", // 远程撤销自身不走远程
        "",
    ] {
        assert!(rpc::lookup(name).is_none(), "不应进白名单: {name}");
    }
}

#[test]
fn parse_rejects_shape_mismatch() {
    // parse 的拒绝路径：缺必填字段即报错（错误消息给人读）
    #[derive(serde::Deserialize, Debug)]
    #[serde(rename_all = "camelCase")]
    #[allow(dead_code)]
    struct Args {
        session_id: String,
    }
    let err = rpc::parse::<Args>(json!({})).unwrap_err();
    assert!(err.contains("参数解析失败"), "错误应含上下文: {err}");

    let ok = rpc::parse::<Args>(json!({"sessionId": "s1"})).unwrap();
    assert_eq!(ok.session_id, "s1");
}

#[test]
fn to_json_flattens_results() {
    assert_eq!(rpc::to_json(Ok::<_, String>(())).unwrap(), json!(null));
    assert_eq!(
        rpc::to_json(Ok::<_, String>(vec![1, 2])).unwrap(),
        json!([1, 2])
    );
    assert_eq!(
        rpc::to_json(Ok::<_, String>(None::<String>)).unwrap(),
        json!(null)
    );
    let err = rpc::to_json(Err::<(), _>("失败原因".to_string())).unwrap_err();
    assert_eq!(err, "失败原因");
}
