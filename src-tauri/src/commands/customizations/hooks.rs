// hooks 子域：settings.json 里的 hooks 清单增删改启停（无独立文件系统存储）。
use super::{load_settings, save_settings, settings_path, CustomizationItem};
// ── Hook Commands ──

#[tauri::command]
pub fn list_hooks() -> Result<Vec<CustomizationItem>, String> {
    let _trace = crate::diagnostics::trace_command("list_hooks");
    let settings = load_settings();
    let hooks = settings
        .get("hooks")
        .cloned()
        .unwrap_or(serde_json::json!({}));

    let mut items = Vec::new();
    if let Some(obj) = hooks.as_object() {
        for (event, event_hooks) in obj {
            if let Some(hooks_array) = event_hooks.as_array() {
                for (index, hook) in hooks_array.iter().enumerate() {
                    let matcher = hook["matcher"].as_str().unwrap_or("");
                    let command = hook["hooks"][0]["command"].as_str().unwrap_or("");
                    let id = format!("{}_{}", event, index);
                    let enabled = !hook
                        .get("disabled")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);

                    items.push(CustomizationItem {
                        id: id.clone(),
                        name: format!("{}: {}", event, matcher),
                        r#type: "hook".to_string(),
                        enabled,
                        path: settings_path().to_string_lossy().to_string(),
                        description: Some(command.to_string()),
                        metadata: Some(serde_json::json!({
                            "event": event,
                            "matcher": matcher,
                            "command": command,
                            "timeout": hook["hooks"][0]["timeout"],
                            "asyncRewake": hook["hooks"][0]["asyncRewake"]
                        })),
                    });
                }
            }
        }
    }
    Ok(items)
}

#[tauri::command]
pub fn create_hook(data: serde_json::Value) -> Result<CustomizationItem, String> {
    let _trace = crate::diagnostics::trace_command("create_hook");
    let event = data["event"].as_str().unwrap_or("PostToolUse");
    let matcher = data["matcher"].as_str().unwrap_or("");
    let command = data["command"].as_str().unwrap_or("");
    let timeout = data["timeout"].as_u64().unwrap_or(60);
    let async_rewake = data["asyncRewake"].as_bool().unwrap_or(false);

    let mut settings = load_settings();
    let hooks = settings
        .as_object_mut()
        .unwrap()
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));

    let event_hooks = hooks
        .as_object_mut()
        .unwrap()
        .entry(event)
        .or_insert_with(|| serde_json::json!([]));

    let new_hook = serde_json::json!({
        "matcher": matcher,
        "hooks": [{
            "type": "command",
            "command": command,
            "timeout": timeout,
            "asyncRewake": async_rewake
        }]
    });

    if let Some(arr) = event_hooks.as_array_mut() {
        arr.push(new_hook);
    }

    save_settings(&settings)?;

    let id = format!("{}_{}", event, 0); // Simplified ID
    Ok(CustomizationItem {
        id,
        name: format!("{}: {}", event, matcher),
        r#type: "hook".to_string(),
        enabled: true,
        path: settings_path().to_string_lossy().to_string(),
        description: Some(command.to_string()),
        metadata: Some(serde_json::json!({
            "event": event,
            "matcher": matcher,
            "command": command,
            "timeout": timeout,
            "asyncRewake": async_rewake
        })),
    })
}

#[tauri::command]
pub fn update_hook(id: String, data: serde_json::Value) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("update_hook");
    // Parse event and index from id (format: "event_index")
    let parts: Vec<&str> = id.splitn(2, '_').collect();
    if parts.len() != 2 {
        return Err(format!("Invalid hook id: {}", id));
    }
    let event = parts[0];
    let index: usize = parts[1]
        .parse()
        .map_err(|_| format!("Invalid hook index: {}", parts[1]))?;

    let mut settings = load_settings();
    if let Some(hooks) = settings.get_mut("hooks") {
        if let Some(event_hooks) = hooks.get_mut(event) {
            if let Some(arr) = event_hooks.as_array_mut() {
                if index < arr.len() {
                    if let Some(matcher) = data["matcher"].as_str() {
                        arr[index]["matcher"] = serde_json::json!(matcher);
                    }
                    if let Some(command) = data["command"].as_str() {
                        arr[index]["hooks"][0]["command"] = serde_json::json!(command);
                    }
                    if let Some(timeout) = data["timeout"].as_u64() {
                        arr[index]["hooks"][0]["timeout"] = serde_json::json!(timeout);
                    }
                    if let Some(async_rewake) = data["asyncRewake"].as_bool() {
                        arr[index]["hooks"][0]["asyncRewake"] = serde_json::json!(async_rewake);
                    }
                }
            }
        }
    }

    save_settings(&settings)
}

#[tauri::command]
pub fn delete_hook(id: String) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("delete_hook");
    let parts: Vec<&str> = id.splitn(2, '_').collect();
    if parts.len() != 2 {
        return Err(format!("Invalid hook id: {}", id));
    }
    let event = parts[0];
    let index: usize = parts[1]
        .parse()
        .map_err(|_| format!("Invalid hook index: {}", parts[1]))?;

    let mut settings = load_settings();
    if let Some(hooks) = settings.get_mut("hooks") {
        if let Some(event_hooks) = hooks.get_mut(event) {
            if let Some(arr) = event_hooks.as_array_mut() {
                if index < arr.len() {
                    arr.remove(index);
                }
            }
        }
    }

    save_settings(&settings)
}

#[tauri::command]
pub fn toggle_hook(id: String, enabled: bool) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("toggle_hook");
    let parts: Vec<&str> = id.splitn(2, '_').collect();
    if parts.len() != 2 {
        return Err(format!("Invalid hook id: {}", id));
    }
    let event = parts[0];
    let index: usize = parts[1]
        .parse()
        .map_err(|_| format!("Invalid hook index: {}", parts[1]))?;

    let mut settings = load_settings();
    if let Some(hooks) = settings.get_mut("hooks") {
        if let Some(event_hooks) = hooks.get_mut(event) {
            if let Some(arr) = event_hooks.as_array_mut() {
                if index < arr.len() {
                    if let Some(hook_obj) = arr[index].as_object_mut() {
                        if enabled {
                            hook_obj.remove("disabled");
                        } else {
                            hook_obj.insert("disabled".to_string(), serde_json::json!(true));
                        }
                    }
                } else {
                    return Err(format!(
                        "Hook index {} out of range for event '{}'",
                        index, event
                    ));
                }
            }
        } else {
            return Err(format!("Hook event '{}' not found", event));
        }
    } else {
        return Err("No hooks found in settings".to_string());
    }

    save_settings(&settings)
}
