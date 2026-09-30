//! 会话存活查询：问 agent runtime（`AgentRuntimeManager`）。runtime 在 Host 模型 P0-4 迁入
//! aide-core 前留在桌面；其余会话命令在 `aide_core::commands::session`。

use tauri::State;

/// 会话进程是否存活（唯一权威来源：Rust 侧存活表，见 `AgentRuntimeManager::session_alive`）。
///
/// 远程端用它决定模型下拉的口径：
///  - **存活** → 锁定会话自己的供应商。此时切到别的供应商的模型，请求会带着新模型名
///    打到旧供应商的 baseUrl 上，直接 400（手机端报的 `glm` 送到 deepseek 就是这么来的）。
///  - **未存活** → 跟随全局激活供应商，与桌面「有活进程才锁定」同一语义。
///
/// 此前远程端无从判断，只能无条件按全局算下拉，于是存活会话也被换成了别的供应商的模型。
#[tauri::command]
pub fn session_alive(
    id: String,
    runtime_mgr: State<'_, crate::runtime::AgentRuntimeManager>,
) -> Result<bool, String> {
    Ok(runtime_mgr.is_session_alive(&id))
}

