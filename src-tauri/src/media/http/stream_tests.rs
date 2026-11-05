use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize};

use super::*;
use crate::host_door::target::HostTarget;
use crate::media::{host, types::FileInfo};

async fn fixture(size: u64) -> (tempfile::TempDir, HostTarget, FileInfo) {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("sample.mp4");
    let mut file = File::create(&path).unwrap();
    file.set_len(size).unwrap();
    file.seek(SeekFrom::Start(size - 4)).unwrap();
    file.write_all(b"tail").unwrap();
    drop(file);
    let core = aide_core::Core::isolated(root.path().join("host"), Arc::new(aide_core::NullSink));
    let target = HostTarget::Local(core);
    let info = host::open(&target, path.to_str().unwrap(), None).await.unwrap();
    (root, target, info)
}

fn cursor(target: HostTarget, info: &FileInfo, slice: ByteRange) -> (Cursor, Arc<AtomicUsize>, Arc<AtomicBool>, Arc<tokio::sync::Semaphore>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let revoked = Arc::new(AtomicBool::new(false));
    let (observed, closed) = (Arc::clone(&calls), Arc::clone(&revoked));
    let reader = MediaReader::new(target, info.handle.clone(), Arc::new(move || {
        observed.fetch_add(1, Ordering::Relaxed);
        if closed.load(Ordering::Acquire) { return Err("revoked".into()); }
        Ok(())
    }));
    let permits = Arc::new(tokio::sync::Semaphore::new(1));
    let permit = permits.clone().try_acquire_owned().unwrap();
    (Cursor { reader, position: slice.start, remaining: slice.length, _permit: permit }, calls, revoked, permits)
}

fn active(info: FileInfo) -> ActiveFile {
    ActiveFile { info, index: 0, generation: 1, revoked: AtomicBool::new(false) }
}

#[tokio::test]
async fn actual_host_stream_reads_only_the_requested_tail_of_a_large_file() {
    let (_root, target, info) = fixture(64 * 1024 * 1024).await;
    let slice = range::select(Some("bytes=-4"), info.size).unwrap();
    let (cursor, calls, _, permits) = cursor(target, &info, slice);
    assert_eq!(calls.load(Ordering::Relaxed), 0, "constructing a stream must not read ahead");
    let body = StreamBody::new(unfold(cursor, next)).boxed_unsync();
    let response = build(hyper::Response::new(body), &active(info), slice).unwrap();
    assert_eq!(response.status(), 206);
    assert_eq!(response.headers()[header::CONTENT_LENGTH], "4");
    assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 67108860-67108863/67108864");
    assert_eq!(response.into_body().collect().await.unwrap().to_bytes(), "tail");
    assert_eq!(calls.load(Ordering::Relaxed), 2, "one bounded read validates before and after IO");
    assert_eq!(permits.available_permits(), 1);
}

#[tokio::test]
async fn dropping_an_unpolled_response_releases_the_permit_without_any_file_read() {
    let (_root, target, info) = fixture(64 * 1024 * 1024).await;
    let slice = range::select(None, info.size).unwrap();
    let (cursor, calls, _, permits) = cursor(target, &info, slice);
    let body = StreamBody::new(unfold(cursor, next)).boxed_unsync();
    assert_eq!(permits.available_permits(), 0);
    drop(body);
    assert_eq!(permits.available_permits(), 1);
    assert_eq!(calls.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn revocation_stops_the_next_chunk_and_never_mixes_a_replacement_source() {
    let (_root, target, info) = fixture(64 * 1024 * 1024).await;
    let slice = range::select(None, info.size).unwrap();
    let (cursor, calls, revoked, permits) = cursor(target, &info, slice);
    let mut body = StreamBody::new(unfold(cursor, next)).boxed_unsync();
    let first = body.frame().await.unwrap().unwrap().into_data().unwrap();
    assert_eq!(first.len(), CHUNK_BYTES as usize);
    assert_eq!(calls.load(Ordering::Relaxed), 2);
    revoked.store(true, Ordering::Release);
    assert!(body.frame().await.unwrap().unwrap_err().to_string().contains("revoked"));
    drop(body);
    assert_eq!(permits.available_permits(), 1);
    assert_eq!(calls.load(Ordering::Relaxed), 3, "the failed authorization gate must precede another file read");
}

#[tokio::test]
async fn full_get_and_head_have_truthful_lengths() {
    let (_root, target, info) = fixture(20).await;
    let slice = range::select(None, info.size).unwrap();
    let (cursor, _, _, _) = cursor(target, &info, slice);
    let response = build(hyper::Response::new(StreamBody::new(unfold(cursor, next)).boxed_unsync()), &active(info.clone()), slice).unwrap();
    assert_eq!(response.status(), 200);
    assert!(!response.headers().contains_key(header::CONTENT_RANGE));
    assert_eq!(response.into_body().collect().await.unwrap().to_bytes().len(), 20);
    let head = build(resource_server::full(200, &info.mime, ""), &active(info), slice).unwrap();
    assert_eq!(head.headers()[header::CONTENT_LENGTH], "20");
    assert!(head.into_body().collect().await.unwrap().to_bytes().is_empty());
    let invalid = unsatisfied(20);
    assert_eq!(invalid.status(), 416);
    assert_eq!(invalid.headers()[header::CONTENT_RANGE], "bytes */20");
}
