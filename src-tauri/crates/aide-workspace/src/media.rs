//! Safe descriptor-backed access to approved media files.

mod file;

pub use file::{MediaFile, MediaInfo, MAX_MEDIA_CHUNK_BYTES};
