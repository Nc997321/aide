use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

use super::detectors::detect_run_targets as detect_targets;
use super::our_config_dir;

pub use super::detectors::RunTarget;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RunConfig {
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub command: String,
    /// 启动该配置时注入子进程的环境变量（覆盖继承的系统值）。
    /// JDK 已从 per-config（env.JAVA_HOME）升级为工作区级（state.json
    /// workspace_jdks），list_run_configs 读出时自动迁移剥除——见
    /// migrate_per_config_java_home。旧 run-config JSON 无此字段 → serde
    /// default 回填空 → 不注入 → 原行为不变。
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
}

fn encode_key(ws_key: &str) -> String {
    ws_key.replace([':', '\\', '/'], "-")
}

fn configs_path(ws_key: &str) -> std::path::PathBuf {
    our_config_dir()
        .join("run_configs")
        .join(format!("{}.json", encode_key(ws_key)))
}

#[tauri::command]
pub fn list_run_configs(ws_key: String) -> Result<Vec<RunConfig>, String> {
    let _trace = crate::diagnostics::trace_command("list_run_configs");
    let path = configs_path(&ws_key);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut configs: Vec<RunConfig> = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    migrate_per_config_java_home(&ws_key, &mut configs, &path);
    Ok(configs)
}

/// 存量迁移（2026-08-08）：JDK 选择从 per-config（env.JAVA_HOME）升级为工作区级
///（state.json workspace_jdks[key]）——一个工作区一个 JDK，所有模块共享。
/// 首个带 JAVA_HOME 的配置值提升为工作区 JDK（工作区已选过则尊重现值、仅剥除），
/// 所有配置的 env 剥除 JAVA_HOME（保留其他键），有改动即写回文件。
/// ws_key 即工作区路径：encode_key 与 workspace::path_to_key 是同一变换
///（`: \ /` → `-`），两边 key 天然一致。
fn migrate_per_config_java_home(ws_key: &str, configs: &mut [RunConfig], path: &Path) {
    let first_jh = configs
        .iter()
        .filter_map(|c| c.env.get("JAVA_HOME"))
        .find(|s| !s.is_empty())
        .cloned();
    let Some(first_jh) = first_jh else { return };
    let key = super::workspace::path_to_key(ws_key);
    if super::workspace::workspace_jdk(&key).is_none() {
        if let Err(e) = super::workspace::set_workspace_jdk(&key, &first_jh) {
            tracing::warn!("run_configs: migrate JAVA_HOME → workspace_jdk failed: {e}");
        }
    }
    let mut touched = false;
    for c in configs.iter_mut() {
        touched |= c.env.remove("JAVA_HOME").is_some();
    }
    if !touched {
        return;
    }
    match serde_json::to_string_pretty(configs) {
        Ok(data) => {
            if let Err(e) = fs::write(path, data) {
                tracing::warn!("run_configs: rewrite after JDK migration failed: {e}");
            }
        }
        Err(e) => tracing::warn!("run_configs: re-serialize after JDK migration failed: {e}"),
    }
}

#[tauri::command]
pub fn save_run_configs(ws_key: String, configs: Vec<RunConfig>) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("save_run_configs");
    let path = configs_path(&ws_key);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(&configs).map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn detect_run_targets(cwd: String) -> Result<Vec<RunTarget>, String> {
    tokio::task::spawn_blocking(move || Ok(detect_targets(Path::new(&cwd))))
        .await
        .map_err(|e| format!("detect_run_targets task panicked: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 旧 run-config JSON 没有 `env` 字段时，反序列化必须回填空 env 而非报错
    /// ——保证本次加字段是非破坏性的，存量配置行为不变。
    #[test]
    fn run_config_env_defaults_empty_when_absent() {
        let json = r#"[{"id":"rc_1","name":"svc","cwd":"/p","command":"mvn spring-boot:run"}]"#;
        let configs: Vec<RunConfig> = serde_json::from_str(json).unwrap();
        assert_eq!(configs.len(), 1);
        assert!(
            configs[0].env.is_empty(),
            "absent env must default to empty"
        );
    }

    /// 带 env 的配置序列化/反序列化 round-trip，且键有序（BTreeMap）。
    #[test]
    fn run_config_env_round_trip() {
        let cfg = RunConfig {
            id: "rc_1".into(),
            name: "svc".into(),
            cwd: "/p".into(),
            command: "mvn spring-boot:run".into(),
            env: {
                let mut m = std::collections::BTreeMap::new();
                m.insert("JAVA_HOME".into(), "/jdks/jdk-21".into());
                m.insert("EXTRA".into(), "x".into());
                m
            },
        };
        let s = serde_json::to_string(&cfg).unwrap();
        assert!(s.contains("\"env\""), "env field must serialize: {s}");
        assert!(s.contains("\"JAVA_HOME\""), "{s}");
        assert!(s.contains("\"EXTRA\""), "{s}");
        // BTreeMap 保证键有序：EXTRA 在 JAVA_HOME 前（E < J）
        let jh = s.find("\"JAVA_HOME\"").unwrap();
        let ex = s.find("\"EXTRA\"").unwrap();
        assert!(
            ex < jh,
            "BTreeMap keys must be sorted (EXTRA before JAVA_HOME): {s}"
        );

        let back: RunConfig = serde_json::from_str(&s).unwrap();
        assert_eq!(
            back.env.get("JAVA_HOME").map(|s| s.as_str()),
            Some("/jdks/jdk-21")
        );
        assert_eq!(back.env.get("EXTRA").map(|s| s.as_str()), Some("x"));
    }

    /// 存量迁移：首个 per-config JAVA_HOME 提升为工作区 JDK，所有配置剥除
    /// JAVA_HOME（保留其他 env 键），并写回文件。
    #[test]
    fn migrate_promotes_first_java_home_and_strips_all() {
        let ws = "aide_test_migrate_jdk_ws1";
        let key = crate::commands::workspace::path_to_key(ws);
        crate::commands::workspace::set_workspace_jdk(&key, "").unwrap(); // 前置：未选
        let dir = std::env::temp_dir().join("aide_test_migrate_jdk_1");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("configs.json");
        let mut configs: Vec<RunConfig> = serde_json::from_str(r#"[
            {"id":"a","name":"a","cwd":"/p","command":"mvn","env":{"JAVA_HOME":"/jdks/jdk-17","EXTRA":"x"}},
            {"id":"b","name":"b","cwd":"/p","command":"mvn","env":{"JAVA_HOME":"/jdks/jdk-21"}}
        ]"#).unwrap();

        migrate_per_config_java_home(ws, &mut configs, &file);

        // 第一个值提升为工作区 JDK
        assert_eq!(
            crate::commands::workspace::workspace_jdk(&key).as_deref(),
            Some("/jdks/jdk-17")
        );
        // 全部剥除，其他键保留
        assert!(configs.iter().all(|c| !c.env.contains_key("JAVA_HOME")));
        assert_eq!(configs[0].env.get("EXTRA").map(|s| s.as_str()), Some("x"));
        // 写回的文件也是剥除后的
        let on_disk: Vec<RunConfig> =
            serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert!(on_disk.iter().all(|c| !c.env.contains_key("JAVA_HOME")));

        crate::commands::workspace::set_workspace_jdk(&key, "").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    /// 迁移尊重工作区已选的 JDK：per-config 值不覆盖，仅剥除。
    #[test]
    fn migrate_respects_existing_workspace_jdk() {
        let ws = "aide_test_migrate_jdk_ws2";
        let key = crate::commands::workspace::path_to_key(ws);
        crate::commands::workspace::set_workspace_jdk(&key, "/jdks/jdk-8").unwrap(); // 前置：已选
        let dir = std::env::temp_dir().join("aide_test_migrate_jdk_2");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("configs.json");
        let mut configs: Vec<RunConfig> = serde_json::from_str(
            r#"[
            {"id":"a","name":"a","cwd":"/p","command":"mvn","env":{"JAVA_HOME":"/jdks/jdk-21"}}
        ]"#,
        )
        .unwrap();

        migrate_per_config_java_home(ws, &mut configs, &file);

        assert_eq!(
            crate::commands::workspace::workspace_jdk(&key).as_deref(),
            Some("/jdks/jdk-8"),
            "existing workspace JDK must win over per-config values"
        );
        assert!(configs.iter().all(|c| !c.env.contains_key("JAVA_HOME")));

        crate::commands::workspace::set_workspace_jdk(&key, "").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }
}
