//! 暂存上传的文件：GUI 那台机器上的文件（拖入的 / 剪贴板里的 / 粘贴的截图）进到 Host。
//!
//! 一个窗口 = 一个 Host：Host 窗口里 agent 只看得见 Host 上的文件，GUI 机器的本地路径对它
//! 毫无意义——所以「把本机文件弄进对话」= 把字节写进 **Host** 的暂存目录，返回 Host 路径，
//! 之后走与粘贴文件同一条管道（`@path` 引用 / 图片附件）。本机窗口里 Host 就是本机。

use std::sync::Arc;

use serde::Deserialize;

use crate::registry::{blocking, Command as HostCommand};
use crate::{command, Core};

pub static COMMANDS: &[HostCommand] = &[command!("stage_dropped_file", stage_dropped_file)];

#[derive(Deserialize)]
pub struct StageDroppedFileArgs {
    name: String,
    base64: String,
}

/// 把字节写进 Host 的暂存目录（`<temp>/aide-dropped/<name>`，重名追加 ` (n)`），返回该路径。
async fn stage_dropped_file(_core: Arc<Core>, a: StageDroppedFileArgs) -> Result<String, String> {
    blocking(move || {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(a.base64.as_bytes())
            .map_err(|e| format!("invalid base64: {e}"))?;

        let dir = std::env::temp_dir().join("aide-dropped");
        std::fs::create_dir_all(&dir).map_err(|e| format!("create temp dir: {e}"))?;

        // 防御：只取最终文件名，丢弃任何路径分隔符。
        let clean = a.name.rsplit(['/', '\\']).next().unwrap_or(&a.name);
        let target = unique_drop_path(&dir, clean);

        std::fs::write(&target, &bytes).map_err(|e| format!("write temp file: {e}"))?;
        Ok(target.to_string_lossy().to_string())
    })
    .await
}

/// Resolve `dir/name` to a non-existing path, appending ` (n)` before the
/// extension on collision so repeated drops of the same file don't overwrite.
fn unique_drop_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let direct = dir.join(name);
    if !direct.exists() {
        return direct;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i + 1..]),
        _ => (name, ""),
    };
    for i in 1..100_000u32 {
        let trial = if ext.is_empty() {
            format!("{stem} ({i})")
        } else {
            format!("{stem} ({i}).{ext}")
        };
        let p = dir.join(&trial);
        if !p.exists() {
            return p;
        }
    }
    direct
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_names_get_numbered() {
        let dir = std::env::temp_dir().join(format!("aide-stage-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let first = unique_drop_path(&dir, "a.png");
        std::fs::write(&first, b"x").unwrap();
        assert_eq!(unique_drop_path(&dir, "a.png"), dir.join("a (1).png"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
