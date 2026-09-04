//! 删除记忆（观测台 v1 唯一写操作）：删 topic 文件 + 同步移除 MEMORY.md 里
//! 引用它的索引行（防删出死链）。死链条目（文件已不存在）走同一命令的
//! 「仅摘索引行」路径。

use std::fs;

use serde::Serialize;

use super::parse;
use super::resolve;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    /// topic 文件被实际删除。
    pub deleted: bool,
    /// MEMORY.md 里引用该文件的索引行被移除。
    pub index_line_removed: bool,
}

pub fn delete_memory(workspace_key: &str, name: &str) -> Result<DeleteResult, String> {
    let name = resolve::confine_name(name)?;
    if name == "MEMORY.md" {
        return Err("MEMORY.md 本体不可删除".into());
    }
    let dirs = resolve::memory_dirs(workspace_key);
    delete_in_dirs(&dirs, &name)
}

/// 与目录来源解耦的删除本体（fixture 测试直接喂目录）。
fn delete_in_dirs(dirs: &[std::path::PathBuf], name: &str) -> Result<DeleteResult, String> {
    let mut deleted = false;
    for p in resolve::locate(dirs, name) {
        fs::remove_file(&p).map_err(|e| format!("delete {}: {e}", p.display()))?;
        deleted = true;
    }

    let mut index_line_removed = false;
    for dir in dirs {
        let idx = dir.join("MEMORY.md");
        let Ok(content) = fs::read_to_string(&idx) else { continue };
        let kept: Vec<&str> = content
            .lines()
            .filter(|l| !parse::parse_links(l).iter().any(|(_, f)| f == name))
            .collect();
        let removed = content.lines().count() - kept.len();
        if removed > 0 {
            let mut out = kept.join("\n");
            if content.ends_with('\n') && !out.is_empty() {
                out.push('\n');
            }
            fs::write(&idx, out).map_err(|e| format!("update MEMORY.md: {e}"))?;
            index_line_removed = true;
        }
    }

    if !deleted && !index_line_removed {
        return Err(format!("memory not found: {name}"));
    }
    Ok(DeleteResult { deleted, index_line_removed })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("aide_mo_del_{}_{}", std::process::id(), tag));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn delete_removes_file_and_index_line() {
        let dir = fixture_dir("basic");
        fs::write(dir.join("MEMORY.md"), "# M\n- [甲](a.md) — x\n- [乙](b.md) — y\n").unwrap();
        fs::write(dir.join("a.md"), "A").unwrap();
        fs::write(dir.join("b.md"), "B").unwrap();

        let r = delete_in_dirs(&[dir.clone()], "a.md").unwrap();
        assert!(r.deleted && r.index_line_removed);
        assert!(!dir.join("a.md").exists());
        let idx = fs::read_to_string(dir.join("MEMORY.md")).unwrap();
        assert!(!idx.contains("a.md"));
        assert!(idx.contains("b.md"), "别的条目不受影响");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_multi_link_line_removes_whole_line() {
        let dir = fixture_dir("multi");
        fs::write(dir.join("MEMORY.md"), "- [甲](a.md) 与 [乙](b.md)\n").unwrap();
        fs::write(dir.join("a.md"), "A").unwrap();
        fs::write(dir.join("b.md"), "B").unwrap();

        let r = delete_in_dirs(&[dir.clone()], "a.md").unwrap();
        assert!(r.deleted && r.index_line_removed);
        let idx = fs::read_to_string(dir.join("MEMORY.md")).unwrap();
        assert!(idx.trim().is_empty(), "一行多链接只摘该行（定案）");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_deadlink_only_removes_index_line() {
        let dir = fixture_dir("deadlink");
        fs::write(dir.join("MEMORY.md"), "- [幽](gone.md) — x\n- [在](stay.md) — y\n").unwrap();
        fs::write(dir.join("stay.md"), "S").unwrap();

        let r = delete_in_dirs(&[dir.clone()], "gone.md").unwrap();
        assert!(!r.deleted && r.index_line_removed);
        let idx = fs::read_to_string(dir.join("MEMORY.md")).unwrap();
        assert!(!idx.contains("gone.md"));
        assert!(idx.contains("stay.md"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_unreferenced_file_leaves_index() {
        let dir = fixture_dir("orphan");
        fs::write(dir.join("MEMORY.md"), "- [甲](a.md) — x\n").unwrap();
        fs::write(dir.join("a.md"), "A").unwrap();
        fs::write(dir.join("b.md"), "孤儿").unwrap();

        let r = delete_in_dirs(&[dir.clone()], "b.md").unwrap();
        assert!(r.deleted && !r.index_line_removed);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_unknown_errors() {
        let dir = fixture_dir("unknown");
        fs::write(dir.join("MEMORY.md"), "- [甲](a.md) — x\n").unwrap();
        assert!(delete_in_dirs(&[dir.clone()], "nope.md").is_err());

        let _ = fs::remove_dir_all(&dir);
    }
}
