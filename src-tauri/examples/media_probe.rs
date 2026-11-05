//! 独立 GUI 验收宿主，根目录必须由调用方提供临时目录；不重启正常 Aide。

#[cfg(not(debug_assertions))]
fn main() { eprintln!("media_probe is available only in debug builds"); }

#[cfg(debug_assertions)]
fn main() {
    let mut args = std::env::args_os().skip(1);
    let Some(root) = args.next().map(std::path::PathBuf::from) else {
        eprintln!("usage: media_probe <isolated-root> <media-file> [other-media-files...]");
        std::process::exit(2);
    };
    let files = args.map(std::path::PathBuf::from).collect();
    if let Err(error) = aide::run_media_probe(root, files) {
        eprintln!("media probe: {error}");
        std::process::exit(1);
    }
}
