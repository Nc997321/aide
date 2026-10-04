//! 解压（tar.gz / zip / 单文件 gz）。所有写入都限制在目标目录内：
//! 条目路径只接受普通组件——`..`、绝对路径、盘符前缀一律拒绝；符号链接不展开（跳过）。

use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};

/// 把归档里的相对路径安全地接到 `dest` 下；不安全 = None。
fn safe_join(dest: &Path, rel: &Path) -> Option<PathBuf> {
    let mut out = dest.to_path_buf();
    let mut any = false;
    for c in rel.components() {
        match c {
            Component::Normal(p) => {
                out.push(p);
                any = true;
            }
            Component::CurDir => {}
            _ => return None,
        }
    }
    any.then_some(out)
}

fn write_file(path: &Path, data: &[u8], executable: bool) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    std::fs::write(path, data).map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
    #[cfg(unix)]
    if executable {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
    }
    #[cfg(not(unix))]
    let _ = executable;
    Ok(())
}

/// 解 tar.gz 到 `dest`。`strip_first` = 去掉每个条目的第一级目录（npm tarball 的 `package/`）。
pub fn untar_gz(bytes: &[u8], dest: &Path, strip_first: Option<()>) -> Result<(), String> {
    let mut ar = tar::Archive::new(flate2::read::GzDecoder::new(Cursor::new(bytes)));
    for entry in ar.entries().map_err(|e| format!("读取归档失败：{e}"))? {
        let mut entry = entry.map_err(|e| format!("读取归档失败：{e}"))?;
        let kind = entry.header().entry_type();
        if !(kind.is_file() || kind.is_dir()) {
            continue; // 符号链接 / 设备文件等一律不展开
        }
        let path = entry.path().map_err(|e| format!("归档条目路径无效：{e}"))?.into_owned();
        let rel: PathBuf = if strip_first.is_some() {
            path.components().skip(1).collect()
        } else {
            path
        };
        if rel.as_os_str().is_empty() {
            continue;
        }
        let target = safe_join(dest, &rel).ok_or_else(|| format!("归档里有越界路径：{}", rel.display()))?;
        if kind.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| format!("创建目录失败：{e}"))?;
            continue;
        }
        let mode = entry.header().mode().unwrap_or(0o644);
        let mut data = Vec::new();
        entry.read_to_end(&mut data).map_err(|e| format!("解压失败：{e}"))?;
        write_file(&target, &data, mode & 0o111 != 0)?;
    }
    Ok(())
}

/// 解整个 zip 到 `dest`。
pub fn unzip_all(bytes: &[u8], dest: &Path) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("读取 zip 失败：{e}"))?;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| format!("读取 zip 失败：{e}"))?;
        let rel = f.enclosed_name().ok_or_else(|| format!("zip 里有越界路径：{}", f.name()))?;
        let target = safe_join(dest, &rel).ok_or_else(|| format!("zip 里有越界路径：{}", f.name()))?;
        if f.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| format!("创建目录失败：{e}"))?;
            continue;
        }
        let mut data = Vec::new();
        f.read_to_end(&mut data).map_err(|e| format!("解压失败：{e}"))?;
        write_file(&target, &data, false)?;
    }
    Ok(())
}

/// 从 zip 里取出文件名为 `file_name` 的那个文件（不论在哪一级目录），写到 `dest_file`。
pub fn unzip_one(bytes: &[u8], file_name: &str, dest_file: &Path) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("读取 zip 失败：{e}"))?;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| format!("读取 zip 失败：{e}"))?;
        let hit = f
            .enclosed_name()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().eq_ignore_ascii_case(file_name)))
            .unwrap_or(false);
        if hit && !f.is_dir() {
            let mut data = Vec::new();
            f.read_to_end(&mut data).map_err(|e| format!("解压失败：{e}"))?;
            return write_file(dest_file, &data, true);
        }
    }
    Err(format!("压缩包里没有 {file_name}"))
}

/// 单文件 gzip（rust-analyzer 在 Unix 上的发行形态）解到 `dest_file`，并加可执行位。
pub fn gunzip_to(bytes: &[u8], dest_file: &Path) -> Result<(), String> {
    let mut data = Vec::new();
    flate2::read::GzDecoder::new(Cursor::new(bytes))
        .read_to_end(&mut data)
        .map_err(|e| format!("解压失败：{e}"))?;
    write_file(dest_file, &data, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("aide-archive-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn tgz(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        for (path, data) in entries {
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(0o644);
            h.set_entry_type(tar::EntryType::Regular);
            // 绕过 set_path 的越界检查，构造恶意条目
            let name = h.as_old_mut().name.as_mut();
            name[..path.len()].copy_from_slice(path.as_bytes());
            h.set_cksum();
            builder.append(&h, *data).unwrap();
        }
        let tar = builder.into_inner().unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(&tar).unwrap();
        gz.finish().unwrap()
    }

    #[test]
    fn npm_tarball_strips_package_prefix() {
        let d = tmp("npm");
        untar_gz(&tgz(&[("package/lib/cli.mjs", b"x"), ("package/package.json", b"{}")]), &d, Some(())).unwrap();
        assert!(d.join("lib/cli.mjs").is_file());
        assert!(d.join("package.json").is_file());
    }

    #[test]
    fn rejects_path_traversal_in_tar() {
        let d = tmp("evil");
        let err = untar_gz(&tgz(&[("package/../../evil.txt", b"x")]), &d, Some(())).unwrap_err();
        assert!(err.contains("越界"), "{err}");
        assert!(!d.parent().unwrap().join("evil.txt").exists());
    }

    #[test]
    fn gunzip_single_file_is_executable() {
        let d = tmp("gz");
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(b"#!/bin/sh\n").unwrap();
        let out = d.join("bin").join("ra");
        gunzip_to(&gz.finish().unwrap(), &out).unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), b"#!/bin/sh\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_ne!(std::fs::metadata(&out).unwrap().permissions().mode() & 0o111, 0);
        }
    }

    #[test]
    fn unzip_one_finds_nested_binary() {
        let d = tmp("zip");
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default();
        w.start_file("nested/dir/rust-analyzer.exe", opts).unwrap();
        w.write_all(b"MZ").unwrap();
        let bytes = w.finish().unwrap().into_inner();
        unzip_one(&bytes, "rust-analyzer.exe", &d.join("ra.exe")).unwrap();
        assert_eq!(std::fs::read(d.join("ra.exe")).unwrap(), b"MZ");
        assert!(unzip_one(&bytes, "missing.exe", &d.join("x")).is_err());
    }
}
