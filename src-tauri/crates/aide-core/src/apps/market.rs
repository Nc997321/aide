//! 官方应用目录。Host 验证目录签名，再用目录中的摘要校验应用包。

use std::{fs, io::Read, time::Duration};

use base64::{engine::general_purpose::STANDARD, Engine};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    manifest,
    store::{self, Roots},
};
use crate::lsp::packs::archive::unzip_all;

const BASE: &str = "http://106.15.138.139/aide-market/";
const PUBLIC_KEY: &str = "/lmtTtdprx85PIMrO0XjvNJAdMi7GxjjMxsuG9EreSQ=";

#[derive(Deserialize)]
struct SignedCatalog {
    payload: String,
    signature: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    schema_version: u32,
    apps: Vec<Entry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    id: String,
    version: String,
    name: String,
    description: String,
    min_aide_version: String,
    package: Package,
}

#[derive(Deserialize)]
struct Package {
    url: String,
    sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MarketApp {
    id: String,
    name: String,
    description: String,
    available_version: Option<String>,
    installed_version: Option<String>,
    local_version: Option<String>,
    enabled: Option<bool>,
    installed: bool,
    can_update: bool,
    shadowed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MarketListing {
    apps: Vec<MarketApp>,
    catalog_error: Option<String>,
}

fn fetch(path: &str, limit: u64) -> Result<Vec<u8>, String> {
    let response = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout(Duration::from_secs(20))
        .build()
        .get(&format!("{BASE}{path}"))
        .call()
        .map_err(|e| format!("无法读取 Aide 应用市场：{e}"))?;
    if response.status() != 200 {
        return Err(format!("Aide 应用市场返回 HTTP {}", response.status()));
    }
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("市场响应超过大小限制".into());
    }
    Ok(bytes)
}

fn verify_catalog(bytes: &[u8], public_key: &[u8]) -> Result<Catalog, String> {
    let signed: SignedCatalog =
        serde_json::from_slice(bytes).map_err(|e| format!("签名目录格式错误：{e}"))?;
    let payload = STANDARD.decode(signed.payload).map_err(|e| e.to_string())?;
    let signature = STANDARD
        .decode(signed.signature)
        .map_err(|e| e.to_string())?;
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, public_key)
        .verify(&payload, &signature)
        .map_err(|_| "官方应用目录签名无效".to_string())?;
    let catalog: Catalog =
        serde_json::from_slice(&payload).map_err(|e| format!("应用目录格式错误：{e}"))?;
    if catalog.schema_version != 1 {
        return Err(format!("不支持应用目录格式 {}", catalog.schema_version));
    }
    let mut ids = std::collections::HashSet::new();
    for app in &catalog.apps {
        let valid_path = app.package.url.starts_with("packages/")
            && app.package.url.split('/').all(|part| {
                !matches!(part, "" | "." | "..")
                    && part
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"-._".contains(&c))
            });
        if !manifest::valid_id(&app.id)
            || !ids.insert(&app.id)
            || Version::parse(&app.version).is_err()
            || Version::parse(&app.min_aide_version).is_err()
            || !valid_path
            || app.package.sha256.len() != 64
            || !app.package.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(format!("官方应用目录条目无效：{}", app.id));
        }
    }
    Ok(catalog)
}

fn fetch_catalog() -> Result<Catalog, String> {
    let key = STANDARD.decode(PUBLIC_KEY).map_err(|e| e.to_string())?;
    verify_catalog(&fetch("catalog.signed.json", 512 * 1024)?, &key)
}

impl Entry {
    fn compatible(&self) -> bool {
        match (
            Version::parse(env!("CARGO_PKG_VERSION")),
            Version::parse(&self.min_aide_version),
        ) {
            (Ok(host), Ok(min)) => !host.cmp_precedence(&min).is_lt(),
            _ => false,
        }
    }

    fn newer_than(&self, old: &str) -> bool {
        match (Version::parse(&self.version), Version::parse(old)) {
            (Ok(new), Ok(old)) => new.cmp_precedence(&old).is_gt(),
            _ => false,
        }
    }
}

pub(super) fn list(roots: &Roots) -> Result<MarketListing, String> {
    list_with_catalog(roots, fetch_catalog())
}

fn list_with_catalog(
    roots: &Roots,
    catalog: Result<Catalog, String>,
) -> Result<MarketListing, String> {
    let mut entries = std::collections::BTreeMap::new();
    let mut ids = store::market_recovery_ids(roots);
    if let Ok(catalog) = &catalog {
        for entry in &catalog.apps {
            if entry.compatible() {
                entries.insert(entry.id.as_str(), entry);
                ids.insert(entry.id.clone());
            }
        }
    }
    let mut apps = std::collections::BTreeMap::new();
    for id in ids.into_iter().filter(|id| manifest::valid_id(id)) {
        let (installed, installed_version, shadowed) = store::market_installation(roots, &id)?;
        let entry = entries.get(id.as_str());
        if !installed && entry.is_none() {
            continue;
        }
        apps.insert(
            id.clone(),
            MarketApp {
                name: entry.map_or_else(|| id.clone(), |entry| entry.name.clone()),
                description: entry.map_or_else(String::new, |entry| entry.description.clone()),
                id,
                installed,
                can_update: installed_version
                    .as_deref()
                    .zip(entry)
                    .is_some_and(|(old, entry)| entry.newer_than(old)),
                installed_version,
                local_version: None,
                enabled: None,
                available_version: entry.map(|entry| entry.version.clone()),
                shadowed,
            },
        );
    }
    // 扫描开发版和恢复成功的安装版，补齐本地状态。
    for local in store::list(roots) {
        let shadowed = local.source == store::Source::Workspace;
        let local_version =
            (!local.version.is_empty() && (!shadowed || !local.installed)).then_some(local.version);
        let app = apps.entry(local.id.clone()).or_insert_with(|| MarketApp {
            id: local.id,
            name: local.name.clone(),
            description: String::new(),
            available_version: None,
            installed_version: None,
            local_version: None,
            enabled: None,
            installed: local.installed,
            can_update: false,
            shadowed,
        });
        app.local_version = local_version;
        app.enabled = local.error.is_none().then_some(local.enabled);
        if app.available_version.is_none() || (app.installed_version.is_none() && local.installed) {
            app.name = local.name;
        }
    }
    Ok(MarketListing {
        apps: apps.into_values().collect(),
        catalog_error: catalog.err(),
    })
}

pub(super) fn install(
    roots: &Roots,
    id: &str,
    version: &str,
    previous: Option<&str>,
) -> Result<(), String> {
    let catalog = fetch_catalog()?;
    let release = catalog
        .apps
        .iter()
        .find(|app| app.id == id && app.version == version && app.compatible())
        .ok_or_else(|| "该版本已不在官方目录中或与当前 Host 不兼容，请刷新后重试".to_string())?;
    if previous.is_some_and(|old| !release.newer_than(old)) {
        return Err("请选择比当前安装版更新的发行版本".into());
    }
    let bytes = fetch(&release.package.url, 32 * 1024 * 1024)?;
    if !format!("{:x}", Sha256::digest(&bytes)).eq_ignore_ascii_case(&release.package.sha256) {
        return Err("应用包校验失败".into());
    }
    fs::create_dir_all(&roots.user_apps).map_err(|e| e.to_string())?;
    let staging = tempfile::Builder::new()
        .prefix(".market-")
        .tempdir_in(&roots.user_apps)
        .map_err(|e| e.to_string())?;
    unzip_all(&bytes, staging.path())?;
    let text = fs::read_to_string(staging.path().join(manifest::MANIFEST_FILE))
        .map_err(|e| e.to_string())?;
    let app = manifest::parse(&text, id)?;
    if app.version != version
        || app.server.is_some()
        || !staging.path().join(&app.panel.entry).is_file()
        || app
            .icon
            .as_ref()
            .is_some_and(|icon| !staging.path().join(icon).is_file())
    {
        return Err("应用包内容与发行记录不一致".into());
    }
    store::install_market_app(roots, id, version, previous, staging.path())
}

pub(super) fn uninstall(roots: &Roots, id: &str, version: &str) -> Result<(), String> {
    if !manifest::valid_id(id) {
        return Err("应用 ID 不合法".into());
    }
    store::uninstall_market_app(roots, id, version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_new_apps_from_signed_catalog_and_rejects_modified_payload() {
        use ring::{
            rand::SystemRandom,
            signature::{Ed25519KeyPair, KeyPair},
        };
        let key = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let key = Ed25519KeyPair::from_pkcs8(key.as_ref()).unwrap();
        let payload = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "apps": [{
                "id": "new-app", "name": "New app", "description": "Catalog only",
                "version": "1.2.0", "minAideVersion": env!("CARGO_PKG_VERSION"),
                "package": { "url": "packages/new-app/1.2.0/new-app.zip", "sha256": "00".repeat(32) }
            }]
        })).unwrap();
        let signature = STANDARD.encode(key.sign(&payload).as_ref());
        let envelope = |payload: &[u8]| {
            serde_json::to_vec(&serde_json::json!({
                "payload": STANDARD.encode(payload), "signature": signature
            }))
            .unwrap()
        };
        let catalog = verify_catalog(&envelope(&payload), key.public_key().as_ref()).unwrap();
        assert_eq!(catalog.apps[0].id, "new-app");
        assert!(catalog.apps[0].compatible());
        assert!(catalog.apps[0].newer_than("1.1.0"));
        let mut tampered = payload;
        tampered.push(b' ');
        assert!(verify_catalog(&envelope(&tampered), key.public_key().as_ref()).is_err());
    }

    #[test]
    fn lists_local_apps_outside_catalog_even_when_offline() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace-apps");
        let roots = Roots {
            user_apps: temp.path().join("apps"),
            data: temp.path().join("app-data"),
            workspace_apps: Some(workspace.clone()),
            daily_apps: None,
            workspace_root: None,
            workspace_trusted: false,
        };
        for (root, id, name) in [
            (&roots.user_apps, "task-runner", "任务面板"),
            (&workspace, "draft-app", "开发工具"),
        ] {
            let dir = root.join(id);
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join(manifest::MANIFEST_FILE),
                serde_json::json!({
                    "id": id, "name": name, "version": "0.1.0", "panel": { "entry": "index.html" }
                })
                .to_string(),
            )
            .unwrap();
            fs::write(dir.join("index.html"), "").unwrap();
        }
        let listing = list_with_catalog(&roots, Err("offline".into())).unwrap();
        let installed = listing
            .apps
            .iter()
            .find(|app| app.id == "task-runner")
            .unwrap();
        assert_eq!(installed.name, "任务面板");
        assert!(installed.installed);
        assert!(installed.installed_version.is_none());
        assert!(installed.available_version.is_none());
        let draft = listing
            .apps
            .iter()
            .find(|app| app.id == "draft-app")
            .unwrap();
        assert!(!draft.installed);
        assert!(draft.shadowed);
        assert_eq!(listing.catalog_error.as_deref(), Some("offline"));
    }

    #[test]
    #[ignore = "需要访问线上应用市场"]
    fn installs_published_counter_on_an_empty_host() {
        let temp = tempfile::tempdir().unwrap();
        let roots = Roots {
            user_apps: temp.path().join("apps"),
            data: temp.path().join("app-data"),
            workspace_apps: None,
            daily_apps: None,
            workspace_root: None,
            workspace_trusted: false,
        };
        let catalog = list(&roots).unwrap();
        assert!(catalog.catalog_error.is_none());
        assert_eq!(catalog.apps.len(), 1);
        assert!(!catalog.apps[0].installed);

        install(&roots, "counter", "0.1.0", None).unwrap();
        let app = store::locate(&roots, "counter").unwrap();
        assert!(app.dir.join(&app.manifest.panel.entry).is_file());
        assert!(!store::list(&roots)[0].consented);
        assert_eq!(
            list(&roots).unwrap().apps[0].installed_version.as_deref(),
            Some("0.1.0")
        );
        assert!(install(&roots, "counter", "0.1.0", Some("0.1.0")).is_err());
        uninstall(&roots, "counter", "0.1.0").unwrap();
        assert!(!list(&roots).unwrap().apps[0].installed);
    }
}
