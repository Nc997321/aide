//! 跑 `tests/fixtures/*.json` 里的全部一致性向量（对着假 Host）。
//! aide-host 的真实后端用同一批向量验证自己（见它的测试）。

use aide_link::conformance::run_fixture;
use aide_link::testkit::FakeHarness;
use serde_json::Value;

fn fixtures() -> Vec<(String, Value)> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    files
        .into_iter()
        .flat_map(|p| {
            let text = std::fs::read_to_string(&p).unwrap();
            let doc: Value = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
            doc.as_array().unwrap_or_else(|| panic!("{} must be an array", p.display())).clone()
        })
        .map(|v| (v["name"].as_str().unwrap_or("?").to_string(), v))
        .collect()
}

#[tokio::test]
async fn every_conformance_vector_passes_against_the_fake_host() {
    let all = fixtures();
    assert!(all.len() >= 20, "fixtures went missing: only {}", all.len());
    let mut failures = Vec::new();
    for (name, fixture) in &all {
        // 每个向量一个全新的 Host（独立的凭据 / 事件序号）
        let h = FakeHarness::new();
        if let Err(e) = run_fixture(&h, fixture).await {
            failures.push(format!("{name}: {e}"));
        }
    }
    assert!(failures.is_empty(), "{} vector(s) failed:\n{}", failures.len(), failures.join("\n\n"));
}
