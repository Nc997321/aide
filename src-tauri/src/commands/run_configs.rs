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
    /// 目前用于按项目选 JDK：存 `JAVA_HOME`，spawn 时再据此前置 `bin` 到 `PATH`。
    /// 旧 run-config JSON 无此字段 → serde default 回填空 → 不注入 → 原行为不变。
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
    let path = configs_path(&ws_key);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_run_configs(ws_key: String, configs: Vec<RunConfig>) -> Result<(), String> {
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
        assert!(configs[0].env.is_empty(), "absent env must default to empty");
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
        assert!(ex < jh, "BTreeMap keys must be sorted (EXTRA before JAVA_HOME): {s}");

        let back: RunConfig = serde_json::from_str(&s).unwrap();
        assert_eq!(back.env.get("JAVA_HOME").map(|s| s.as_str()), Some("/jdks/jdk-21"));
        assert_eq!(back.env.get("EXTRA").map(|s| s.as_str()), Some("x"));
    }
}
