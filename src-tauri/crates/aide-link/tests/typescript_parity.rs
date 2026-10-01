//! `docs/aide-link/frames.d.ts` 与 Rust 帧定义的对账：手机端照着 d.ts 实现，d.ts 漂了 = 协议静默分叉。

use std::collections::BTreeSet;

use aide_link::frame::{ClientFrame, ErrorCode, HostFrame};

fn dts() -> String {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../docs/aide-link/frames.d.ts");
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

/// 取某个 `export type <name> =` 联合块里所有 `type: "xxx"`。
fn frame_types(src: &str, name: &str) -> BTreeSet<String> {
    let start = src.find(&format!("export type {name} =")).unwrap_or_else(|| panic!("{name} missing in frames.d.ts"));
    let rest = &src[start..];
    let end = rest.find(";\n\n").unwrap_or(rest.len());
    rest[..end]
        .split("type: \"")
        .skip(1)
        .filter_map(|s| s.split('"').next())
        .map(str::to_string)
        .collect()
}

fn set(items: &[&str]) -> BTreeSet<String> {
    items.iter().map(|s| s.to_string()).collect()
}

#[test]
fn client_and_host_frame_types_match_the_typescript_declarations() {
    let src = dts();
    assert_eq!(frame_types(&src, "ClientFrame"), set(ClientFrame::TYPES));
    assert_eq!(frame_types(&src, "HostFrame"), set(HostFrame::TYPES));
}

#[test]
fn error_codes_match_the_typescript_declarations() {
    let src = dts();
    let start = src.find("export type ErrorCode =").unwrap();
    let block = &src[start..src[start..].find(";\n").map(|e| start + e).unwrap()];
    let declared: BTreeSet<String> = block.split('"').skip(1).step_by(2).map(str::to_string).collect();
    let rust: BTreeSet<String> = ErrorCode::ALL.iter().map(|c| c.as_str()).collect();
    assert_eq!(declared, rust);
}

#[test]
fn the_protocol_doc_mentions_every_frame_type_and_error_code() {
    let doc = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../docs/aide-link-protocol.md")).unwrap();
    for t in ClientFrame::TYPES.iter().chain(HostFrame::TYPES) {
        assert!(doc.contains(&format!("`{t}`")) || doc.contains(&format!("\"{t}\"")), "doc never mentions frame `{t}`");
    }
    for c in ErrorCode::ALL {
        assert!(doc.contains(&c.as_str()), "doc never mentions error code `{}`", c.as_str());
    }
}
