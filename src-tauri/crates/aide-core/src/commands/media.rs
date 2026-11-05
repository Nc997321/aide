//! Media preview commands; all filesystem work runs on the blocking pool.

use crate::registry::{blocking, Command};
use crate::{command, Core};
use serde::Deserialize;
use std::sync::Arc;

pub static COMMANDS: &[Command] = &[
    command!("media_open", media_open),
    command!(bytes "media_read", media_read),
    command!("media_close", media_close),
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenArgs {
    path: String,
    expected_revision: Option<String>,
}

async fn media_open(
    core: Arc<Core>,
    args: OpenArgs,
) -> Result<crate::media::MediaOpenReply, String> {
    blocking(move || core.media.open(args.path, args.expected_revision)).await
}

#[derive(Deserialize)]
pub struct ReadArgs {
    handle: String,
    offset: u64,
    length: u64,
}

async fn media_read(core: Arc<Core>, args: ReadArgs) -> Result<Vec<u8>, String> {
    blocking(move || core.media.read(args.handle, args.offset, args.length)).await
}

#[derive(Deserialize)]
pub struct CloseArgs {
    handle: String,
}

async fn media_close(core: Arc<Core>, args: CloseArgs) -> Result<(), String> {
    blocking(move || core.media.close(args.handle)).await
}

#[cfg(test)]
mod tests {
    use crate::registry::{lookup, Reply};
    use crate::{Core, NullSink};
    use serde_json::{json, Value};
    use std::io::{Seek, SeekFrom, Write};
    use std::path::PathBuf;
    use std::sync::Arc;

    fn sparse_media_file() -> (PathBuf, u64) {
        let size = 64 * 1024 * 1024;
        let path =
            std::env::temp_dir().join(format!("aide-core-media-large-{}.mp4", std::process::id()));
        let mut writer = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&path)
            .unwrap();
        writer.set_len(size).unwrap();
        writer.seek(SeekFrom::Start(size - 4)).unwrap();
        writer.write_all(b"tail").unwrap();
        (path, size)
    }

    async fn call(core: Arc<Core>, name: &str, args: Value) -> Result<Reply, String> {
        lookup(name).unwrap_or_else(|| panic!("{name} not registered"))(core, args).await
    }

    #[tokio::test]
    async fn media_commands_are_registered_and_stream_pinned_file_chunks() {
        let core = crate::test_core(Arc::new(NullSink));
        let path = std::env::temp_dir().join(format!(
            "aide-core-media-command-{}.wav",
            std::process::id()
        ));
        std::fs::write(&path, b"wave data").unwrap();
        let opened = call(Arc::clone(&core), "media_open", json!({ "path": path }))
            .await
            .unwrap();
        let Reply::Json(opened) = opened else {
            panic!("media_open must reply JSON")
        };
        assert_eq!(opened["mime"], "audio/wav");
        assert_eq!(opened["size"], 9);
        let handle = opened["handle"].as_str().unwrap().to_string();
        let chunk = call(
            Arc::clone(&core),
            "media_read",
            json!({ "handle": handle, "offset": 2, "length": 4 }),
        )
        .await
        .unwrap();
        let Reply::Bytes(chunk) = chunk else {
            panic!("media_read must reply bytes")
        };
        assert_eq!(chunk, b"ve d");
        call(
            Arc::clone(&core),
            "media_close",
            json!({ "handle": handle }),
        )
        .await
        .unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn media_read_streams_small_chunk_from_sparse_file_over_20_mib() {
        let core = crate::test_core(Arc::new(NullSink));
        let (path, size) = sparse_media_file();
        let opened = call(Arc::clone(&core), "media_open", json!({ "path": path }))
            .await
            .unwrap();
        let Reply::Json(opened) = opened else {
            panic!("media_open must reply JSON")
        };
        assert_eq!(opened["size"], size);
        let handle = opened["handle"].as_str().unwrap().to_string();
        let reply = call(
            core.clone(),
            "media_read",
            json!({ "handle": handle.clone(), "offset": size - 4, "length": 512 }),
        )
        .await
        .unwrap();
        let Reply::Bytes(chunk) = reply else {
            panic!("media_read must reply bytes")
        };
        assert_eq!(chunk, b"tail");
        assert_eq!(chunk.len(), 4);
        call(core, "media_close", json!({ "handle": handle }))
            .await
            .unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn stale_revision_is_rejected_and_invalid_reads_fail() {
        let core = crate::test_core(Arc::new(NullSink));
        let path =
            std::env::temp_dir().join(format!("aide-core-media-stale-{}.mp3", std::process::id()));
        std::fs::write(&path, b"track").unwrap();
        assert!(call(
            Arc::clone(&core),
            "media_open",
            json!({ "path": path, "expectedRevision": "old" })
        )
        .await
        .err()
        .unwrap()
        .contains("stale media"));
        let opened = call(Arc::clone(&core), "media_open", json!({ "path": path }))
            .await
            .unwrap();
        let Reply::Json(opened) = opened else {
            panic!("media_open must reply JSON")
        };
        let err = call(
            core,
            "media_read",
            json!({ "handle": opened["handle"], "offset": 0, "length": 0 }),
        )
        .await
        .err()
        .unwrap();
        assert!(err.contains("greater than zero"));
        std::fs::remove_file(path).unwrap();
    }
}
