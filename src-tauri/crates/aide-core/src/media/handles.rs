use aide_workspace::media::MediaFile;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MAX_OPEN_MEDIA_HANDLES: usize = 32;
const MEDIA_HANDLE_IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);

struct OpenMedia {
    file: MediaFile,
    last_used: Instant,
}

#[derive(Debug, Serialize)]
pub struct MediaOpenReply {
    pub handle: String,
    pub path: String,
    pub mime: String,
    pub size: u64,
    pub revision: String,
}

/// Bounded, idle-expiring table of descriptor-pinned media files for one Host.
#[derive(Default)]
pub struct MediaService {
    open: Mutex<HashMap<String, OpenMedia>>,
}

impl MediaService {
    pub fn open(
        &self,
        path: String,
        expected_revision: Option<String>,
    ) -> Result<MediaOpenReply, String> {
        let file = MediaFile::open(&path, expected_revision.as_deref())?;
        let info = file.info();
        let reply = MediaOpenReply {
            handle: next_handle(),
            path: info.path.clone(),
            mime: info.mime.clone(),
            size: info.size,
            revision: info.revision.clone(),
        };
        let mut open = self
            .open
            .lock()
            .map_err(|_| "media handle table poisoned".to_string())?;
        prune_expired(&mut open);
        if open.len() >= MAX_OPEN_MEDIA_HANDLES {
            evict_oldest(&mut open);
        }
        open.insert(
            reply.handle.clone(),
            OpenMedia {
                file,
                last_used: Instant::now(),
            },
        );
        Ok(reply)
    }

    pub fn read(&self, handle: String, offset: u64, length: u64) -> Result<Vec<u8>, String> {
        let mut open = self
            .open
            .lock()
            .map_err(|_| "media handle table poisoned".to_string())?;
        prune_expired(&mut open);
        let (result, stale) = match open.get_mut(&handle) {
            Some(entry) => {
                entry.last_used = Instant::now();
                let result = entry.file.read(offset, length);
                let stale = result
                    .as_ref()
                    .err()
                    .is_some_and(|error| error.contains("stale media"));
                (result, stale)
            }
            None => return Err("media handle is missing or expired".into()),
        };
        if stale {
            open.remove(&handle);
        }
        result
    }

    pub fn close(&self, handle: String) -> Result<(), String> {
        let mut open = self
            .open
            .lock()
            .map_err(|_| "media handle table poisoned".to_string())?;
        open.remove(&handle);
        Ok(())
    }
}

fn prune_expired(open: &mut HashMap<String, OpenMedia>) {
    let now = Instant::now();
    open.retain(|_, entry| now.duration_since(entry.last_used) < MEDIA_HANDLE_IDLE_TIMEOUT);
}

fn evict_oldest(open: &mut HashMap<String, OpenMedia>) {
    if let Some(oldest) = open
        .iter()
        .min_by_key(|(_, entry)| entry.last_used)
        .map(|(key, _)| key.clone())
    {
        open.remove(&oldest);
    }
}

fn next_handle() -> String {
    format!(
        "{:x}-{:x}",
        std::process::id(),
        NEXT_HANDLE.fetch_add(1, Ordering::Relaxed)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

    static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

    fn media_path() -> String {
        let path = std::env::temp_dir().join(format!(
            "aide-core-media-{}-{}.mp3",
            std::process::id(),
            NEXT_FILE.fetch_add(1, AtomicOrdering::Relaxed)
        ));
        fs::write(&path, b"audio bytes").unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn handle_table_reads_and_closes_idempotently() {
        let service = MediaService::default();
        let path = media_path();
        let opened = service.open(path.clone(), None).unwrap();
        assert_eq!(service.read(opened.handle.clone(), 0, 5).unwrap(), b"audio");
        service.close(opened.handle.clone()).unwrap();
        service.close(opened.handle.clone()).unwrap();
        assert!(service
            .read(opened.handle, 0, 1)
            .unwrap_err()
            .contains("missing or expired"));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn idle_handles_expire_and_are_reclaimed() {
        let service = MediaService::default();
        let path = media_path();
        let opened = service.open(path.clone(), None).unwrap();
        service
            .open
            .lock()
            .unwrap()
            .get_mut(&opened.handle)
            .unwrap()
            .last_used = Instant::now() - MEDIA_HANDLE_IDLE_TIMEOUT - Duration::from_secs(1);
        assert!(service
            .read(opened.handle, 0, 1)
            .unwrap_err()
            .contains("missing or expired"));
        assert!(service.open.lock().unwrap().is_empty());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn handle_limit_evicts_oldest_open_file() {
        let service = MediaService::default();
        let mut handles = Vec::new();
        let mut paths = Vec::new();
        for _ in 0..=MAX_OPEN_MEDIA_HANDLES {
            let path = media_path();
            paths.push(path.clone());
            handles.push(service.open(path, None).unwrap().handle);
        }
        assert!(service
            .read(handles[0].clone(), 0, 1)
            .unwrap_err()
            .contains("missing or expired"));
        assert!(service.read(handles.last().unwrap().clone(), 0, 1).is_ok());
        for handle in handles {
            service.close(handle).unwrap();
        }
        for path in paths {
            fs::remove_file(path).unwrap();
        }
    }
}
