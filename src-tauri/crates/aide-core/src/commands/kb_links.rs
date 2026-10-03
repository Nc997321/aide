//! 知识库「关联项目」：哪些**本 Host 上的工作区**与某篇文档 / 某个文件夹相关。
//!
//! 为什么存 Host 而不是知识库服务端：工作区是这台 Host 上的路径，同事的机器上没有，
//! 名字也可能重名；记忆又是按 Host 自持（各装各的 `~/.aide`）。所以映射跟着记忆走，
//! 落 `~/.aide/kb-links.json`，不同步、不对手机开放。
//!
//! 形状：`{ "<文档或文件夹 id>": ["<工作区 key>", ...] }`。存的是 key（注册时冻结的归属键），
//! 不存路径——展示名与路径由前端按当前工作区列表解析；key 指向的工作区不在了，由界面
//! 标成警示，而不是在这里静默丢掉（用户得知道 AI 少了一份上下文）。文件夹的关联由其下
//! 文档继承（取并集），继承关系在前端按知识库树算，这里只存「直接打在谁身上」。

#[allow(unused_imports)]
use crate::registry::{blocking, Command as HostCommand};
#[allow(unused_imports)]
use crate::{command, Core};
#[allow(unused_imports)]
use serde::Deserialize;
#[allow(unused_imports)]
use std::sync::Arc;

pub static COMMANDS: &[HostCommand] = &[
    command!("kb_links", kb_links),
    command!("set_kb_links", set_kb_links),
];

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub type KbLinks = BTreeMap<String, Vec<String>>;

/// load-modify-save 的临界区：两次并发 set 不能各读各的旧值再互相覆盖（lost update）。
static WRITE_LOCK: Mutex<()> = Mutex::new(());

pub fn kb_links_path() -> PathBuf {
    crate::paths::our_config_dir().join("kb-links.json")
}

/// 读：缺失 / 损坏 → 空（绝不崩；关联项目丢了只是少一份上下文，不该拦住知识库）。
pub fn load_links(path: &Path) -> KbLinks {
    fs::read_to_string(path)
        .ok()
        .and_then(|c| serde_json::from_str::<KbLinks>(&c).ok())
        .unwrap_or_default()
}

/// 纯函数：把 `node_id` 的关联设为 `ws_keys`（去空、去重、保序）；空 = 删掉这条。
pub fn apply_set(links: &mut KbLinks, node_id: &str, ws_keys: &[String]) {
    let mut seen = std::collections::HashSet::new();
    let cleaned: Vec<String> = ws_keys
        .iter()
        .map(|k| k.trim())
        .filter(|k| !k.is_empty() && seen.insert(k.to_string()))
        .map(str::to_string)
        .collect();
    if cleaned.is_empty() {
        links.remove(node_id);
    } else {
        links.insert(node_id.to_string(), cleaned);
    }
}

fn save_links(path: &Path, links: &KbLinks) -> Result<(), String> {
    let dir = path.parent().ok_or_else(|| "kb-links.json has no parent".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("create config dir: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(links).map_err(|e| e.to_string())?;
    fs::write(&tmp, body).map_err(|e| format!("write kb-links temp: {e}"))?;
    if let Err(e) = crate::app_settings::persist_file(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// 读-改-写，整个过程持锁。
pub fn set_links_at(path: &Path, node_id: &str, ws_keys: &[String]) -> Result<KbLinks, String> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut links = load_links(path);
    apply_set(&mut links, node_id, ws_keys);
    save_links(path, &links)?;
    Ok(links)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbLinksArgs {}

async fn kb_links(_core: Arc<Core>, _a: KbLinksArgs) -> Result<KbLinks, String> {
    blocking(|| Ok(load_links(&kb_links_path()))).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetKbLinksArgs {
    node_id: String,
    ws_keys: Vec<String>,
}

/// 设置某个文档 / 文件夹直接关联的工作区（全量覆盖；空数组 = 清掉）。返回写入后的全表，
/// 前端整份换新即可。
async fn set_kb_links(_core: Arc<Core>, a: SetKbLinksArgs) -> Result<KbLinks, String> {
    let SetKbLinksArgs { node_id, ws_keys } = a;
    if node_id.trim().is_empty() {
        return Err("node_id 不能为空".to_string());
    }
    blocking(move || set_links_at(&kb_links_path(), &node_id, &ws_keys)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn apply_set_cleans_dedups_and_keeps_order() {
        let mut l = KbLinks::new();
        apply_set(&mut l, "doc-1", &keys(&["b", " a ", "b", "", "  "]));
        assert_eq!(l["doc-1"], keys(&["b", "a"]));
    }

    #[test]
    fn empty_set_removes_the_entry() {
        let mut l = KbLinks::new();
        apply_set(&mut l, "doc-1", &keys(&["a"]));
        apply_set(&mut l, "doc-1", &[]);
        assert!(l.is_empty());
        apply_set(&mut l, "doc-2", &keys(&["", " "]));
        assert!(l.is_empty(), "全是空白也算清空");
    }

    #[test]
    fn round_trips_through_disk_and_survives_corruption() {
        let dir = std::env::temp_dir().join("aide_kb_links_test");
        let _ = fs::remove_dir_all(&dir);
        let p = dir.join("kb-links.json");
        assert!(load_links(&p).is_empty(), "文件不存在 = 空");

        set_links_at(&p, "doc-1", &keys(&["ws-a", "ws-b"])).unwrap();
        let after = set_links_at(&p, "folder-1", &keys(&["ws-a"])).unwrap();
        assert_eq!(after.len(), 2, "后一次写不丢前一次");
        assert_eq!(load_links(&p)["doc-1"], keys(&["ws-a", "ws-b"]));

        fs::write(&p, "{ not json").unwrap();
        assert!(load_links(&p).is_empty(), "损坏 = 空，不崩");
        let _ = fs::remove_dir_all(&dir);
    }
}
