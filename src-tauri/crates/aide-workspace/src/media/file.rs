use std::fs::{File, Metadata, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

pub const MAX_MEDIA_CHUNK_BYTES: u64 = 512 * 1024;

#[derive(Debug, Clone, serde::Serialize)]
pub struct MediaInfo {
    pub path: String,
    pub mime: String,
    pub size: u64,
    pub revision: String,
}

/// An open descriptor pins reads to the object opened, even if its path is replaced.
#[derive(Debug)]
pub struct MediaFile {
    file: File,
    info: MediaInfo,
}

impl MediaFile {
    pub fn open(path: &str, expected_revision: Option<&str>) -> Result<Self, String> {
        let (file, info) = open_media(path)?;
        if let Some(expected) = expected_revision {
            if expected != info.revision {
                return Err(format!(
                    "stale media: expected revision does not match current file ({})",
                    info.revision
                ));
            }
        }
        Ok(Self { file, info })
    }

    pub fn info(&self) -> &MediaInfo {
        &self.info
    }

    pub fn read(&mut self, offset: u64, length: u64) -> Result<Vec<u8>, String> {
        if length == 0 {
            return Err("media_read length must be greater than zero".into());
        }
        if length > MAX_MEDIA_CHUNK_BYTES {
            return Err(format!(
                "media_read length exceeds {MAX_MEDIA_CHUNK_BYTES} byte limit"
            ));
        }
        offset
            .checked_add(length)
            .ok_or_else(|| "media_read offset overflow".to_string())?;
        self.ensure_current()?;
        if offset >= self.info.size {
            return Ok(Vec::new());
        }
        let count = length.min(self.info.size - offset) as usize;
        self.file
            .seek(SeekFrom::Start(offset))
            .map_err(media_io_error)?;
        let mut bytes = vec![0; count];
        let mut read = 0;
        while read < count {
            match self.file.read(&mut bytes[read..]) {
                Ok(0) => break,
                Ok(n) => read += n,
                Err(error) => return Err(media_io_error(error)),
            }
        }
        bytes.truncate(read);
        self.ensure_current()?;
        if read < count {
            return Err("stale media: file ended during chunk read".into());
        }
        Ok(bytes)
    }

    fn ensure_current(&self) -> Result<(), String> {
        let metadata = self.file.metadata().map_err(media_io_error)?;
        let current = revision(&metadata)?;
        if current != self.info.revision {
            return Err(format!(
                "stale media: file changed after opening ({current})"
            ));
        }
        Ok(())
    }
}

fn open_media(input: &str) -> Result<(File, MediaInfo), String> {
    let canonical = std::fs::canonicalize(input).map_err(media_io_error)?;
    let mime =
        media_mime(&canonical).ok_or_else(|| "unsupported media file extension".to_string())?;
    let candidate = std::fs::metadata(&canonical).map_err(media_io_error)?;
    if !candidate.is_file() {
        return Err("media path must be a regular file".into());
    }
    let file = OpenOptions::new()
        .read(true)
        .open(&canonical)
        .map_err(media_io_error)?;
    let metadata = file.metadata().map_err(media_io_error)?;
    if !metadata.is_file() {
        return Err("media path must be a regular file".into());
    }
    let info = MediaInfo {
        path: canonical.to_string_lossy().into_owned(),
        mime: mime.into(),
        size: metadata.len(),
        revision: revision(&metadata)?,
    };
    Ok((file, info))
}

fn media_mime(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "mp4" => "video/mp4",
        "m4v" => "video/mp4",
        "m4a" => "audio/mp4",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "webm" => "video/webm",
        "ogg" => "audio/ogg",
        "oga" => "audio/ogg",
        "ogv" => "video/ogg",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        "opus" => "audio/opus",
        "aif" | "aiff" => "audio/aiff",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "mpeg" | "mpg" => "video/mpeg",
        "3gp" => "video/3gpp",
        _ => return None,
    })
}

fn revision(metadata: &Metadata) -> Result<String, String> {
    let modified = metadata.modified().map_err(media_io_error)?;
    let modified_ns = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("failed to read media modification time: {e}"))?
        .as_nanos();
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(format!(
            "v1:{}:{modified_ns}:{}:{}:{}:{}:{}",
            metadata.len(),
            metadata.dev(),
            metadata.ino(),
            metadata.ctime(),
            metadata.ctime_nsec(),
            metadata.mode()
        ))
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        Ok(format!(
            "v1:{}:{modified_ns}:{}:{}",
            metadata.len(),
            metadata.creation_time(),
            metadata.file_attributes()
        ))
    }
    #[cfg(not(any(unix, windows)))]
    {
        Ok(format!("v1:{}:{modified_ns}", metadata.len()))
    }
}

fn media_io_error(error: std::io::Error) -> String {
    format!("media file I/O failed: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn temp_file(extension: &str, bytes: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "aide-media-{}-{}.{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
            extension
        ));
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn maps_only_explicit_media_extensions() {
        for (ext, expected) in [
            ("mp4", "video/mp4"),
            ("wav", "audio/wav"),
            ("mp3", "audio/mpeg"),
            ("webm", "video/webm"),
            ("m4a", "audio/mp4"),
            ("ogg", "audio/ogg"),
            ("flac", "audio/flac"),
        ] {
            assert_eq!(
                media_mime(Path::new(&format!("file.{ext}"))),
                Some(expected)
            );
        }
        assert_eq!(media_mime(Path::new("movie.exe")), None);
    }

    #[test]
    fn reads_chunks_and_returns_empty_or_short_at_eof() {
        let path = temp_file("mp4", b"abcdef");
        let mut media = MediaFile::open(path.to_str().unwrap(), None).unwrap();
        assert_eq!(media.read(1, 3).unwrap(), b"bcd");
        assert_eq!(media.read(5, 4).unwrap(), b"f");
        assert!(media.read(6, 2).unwrap().is_empty());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn reads_small_chunk_from_sparse_file_larger_than_legacy_preview_limit() {
        let size = 64 * 1024 * 1024;
        let path = temp_file("mp4", b"");
        let mut writer = OpenOptions::new().write(true).open(&path).unwrap();
        writer.set_len(size).unwrap();
        writer.seek(SeekFrom::Start(size - 4)).unwrap();
        writer.write_all(b"tail").unwrap();
        drop(writer);

        let mut media = MediaFile::open(path.to_str().unwrap(), None).unwrap();
        assert_eq!(media.info().size, size);
        let chunk = media.read(size - 4, 512).unwrap();
        assert_eq!(chunk, b"tail");
        assert_eq!(chunk.len(), 4);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn rejects_invalid_chunks_and_non_regular_or_non_media_paths() {
        let path = temp_file("mp4", b"x");
        let mut media = MediaFile::open(path.to_str().unwrap(), None).unwrap();
        assert!(media.read(0, 0).unwrap_err().contains("greater than zero"));
        assert!(media
            .read(0, MAX_MEDIA_CHUNK_BYTES + 1)
            .unwrap_err()
            .contains("limit"));
        assert!(media.read(u64::MAX, 2).unwrap_err().contains("overflow"));
        assert!(MediaFile::open(std::env::temp_dir().to_str().unwrap(), None).is_err());
        let other = temp_file("txt", b"x");
        assert!(MediaFile::open(other.to_str().unwrap(), None)
            .unwrap_err()
            .contains("extension"));
        fs::remove_file(path).unwrap();
        fs::remove_file(other).unwrap();
    }

    #[test]
    fn pins_open_object_and_rejects_in_place_mutation() {
        let path = temp_file("webm", b"original");
        let mut pinned = MediaFile::open(path.to_str().unwrap(), None).unwrap();
        let replacement = path.with_extension("replacement");
        let displaced = path.with_extension("displaced");
        fs::write(&replacement, b"replaced").unwrap();
        fs::rename(&path, &displaced).unwrap();
        fs::rename(&replacement, &path).unwrap();
        assert_eq!(pinned.read(0, 8).unwrap(), b"original");
        let mut changed = MediaFile::open(path.to_str().unwrap(), None).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(&path, b"changed!").unwrap();
        assert!(changed.read(0, 8).unwrap_err().contains("stale media"));
        fs::remove_file(path).unwrap();
        fs::remove_file(displaced).unwrap();
    }

    #[test]
    fn checks_expected_revision() {
        let path = temp_file("flac", b"audio");
        let opened = MediaFile::open(path.to_str().unwrap(), None).unwrap();
        assert!(MediaFile::open(path.to_str().unwrap(), Some("wrong"))
            .unwrap_err()
            .contains("stale media"));
        assert!(MediaFile::open(path.to_str().unwrap(), Some(&opened.info().revision)).is_ok());
        fs::remove_file(path).unwrap();
    }
}
