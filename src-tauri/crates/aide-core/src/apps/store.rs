//! 应用的发现、同意记录与资源读取。逻辑都以目录为参数（测试用临时目录），
//! 真实布局（`~/.aide/apps`、`{工作区}/.aide/apps`、`~/.aide/app-data`）由 [`Roots`] 给出。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use super::manifest::{self, Manifest, Placement, MANIFEST_FILE};
use super::servers::Spec;

/// 单个资源的上限：防一个失控的文件把内存吃光（界面资源不该这么大）。
const MAX_ASSET_BYTES: u64 = 32 * 1024 * 1024;
/// 算 `revision` 时最多看这么多个文件（防 `node_modules` 把扫描拖死）。
const MAX_REVISION_FILES: usize = 4000;
/// 开发日志：界面的报错、后端的 stderr、清单的问题都记在应用目录里的这个文件，agent 读它就知道
/// 自己写的东西跑成什么样。只给开发态应用写；点号开头，不计入 `revision`（否则写日志会触发重载）。
pub const DEV_LOG: &str = ".aide-dev.log";
const MAX_DEV_LOG: u64 = 256 * 1024;
/// 给 sidecar 读的派生文件：哪些应用后端要挂进 agent 会话（见 [`write_mcp_file`]）。
pub const MCP_FILE: &str = "mcp-servers.json";

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// 已安装：`~/.aide/apps/<id>/`
    User,
    /// 开发态：受信任工作区的 `.aide/apps/<id>/`
    Workspace,
}

#[derive(Clone, Debug)]
pub struct Roots {
    pub user_apps: PathBuf,
    /// 受信任工作区的应用目录；工作区未受信任或没有活动工作区时为 `None`。
    pub workspace_apps: Option<PathBuf>,
    /// 日常目录的应用目录（恒受信任）。会话可以住在日常目录而窗口开着别的工作区——agent 把应用写在
    /// 自己的 cwd 里，只扫活动工作区就永远看不到它。与 `workspace_apps` 相同时只扫一遍。
    pub daily_apps: Option<PathBuf>,
    /// 活动工作区的根（`fs.*` 的边界；与是否受信任无关）。
    pub workspace_root: Option<PathBuf>,
    /// 应用数据与同意记录的根（刻意不在应用目录里：卸载重装不丢，agent 改应用文件时碰不到）。
    pub data: PathBuf,
}

impl Roots {
    /// 按优先级从高到低：活动工作区的开发态 > 日常目录的开发态 > 已安装。
    pub fn app_dirs(&self) -> Vec<(Source, &Path)> {
        let dev = [self.workspace_apps.as_deref(), self.daily_apps.as_deref()];
        let mut dirs: Vec<(Source, &Path)> = dev.into_iter().flatten().map(|d| (Source::Workspace, d)).collect();
        dirs.dedup();
        dirs.push((Source::User, &self.user_apps));
        dirs
    }

    fn state_path(&self) -> PathBuf {
        self.data.join("state.json")
    }

    pub fn data_dir(&self, id: &str) -> PathBuf {
        self.data.join(id)
    }
}

/// 前端看到的一个应用。清单有问题的也列出来（带 `error`）——agent 写坏了清单，
/// 用户得看得见「它在、但坏了」，而不是凭空消失。
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub icon: Option<String>,
    pub placement: Placement,
    pub entry: String,
    pub permissions: Vec<String>,
    pub has_server: bool,
    pub source: Source,
    pub enabled: bool,
    /// 用户已同意**当前这份**权限与后端入口。
    pub consented: bool,
    /// 同意的对象（原样回传给 `app_consent`，保证用户同意的就是他看到的那一份）。
    pub grant: String,
    /// 应用文件的最新修改时刻（毫秒）；变了前端就重载面板。
    pub revision: u64,
    /// 后端里 agent 调用时免确认的工具（见 [`read_only_tools`]）。由命令层填，`list` 本身不起进程。
    pub read_only_tools: Vec<String>,
    /// 这个 id 有安装版。开发态 + `installed` = 装过之后又改了，面板提示「更新安装」。
    pub installed: bool,
    /// 不管开着哪个工作区都看得见：安装版，或放在日常目录里的开发态。面板的提示语据此说真话
    /// （在项目里做的开发态才是「切走就不见」）。
    pub always_visible: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
struct State {
    /// 同意键 → 同意时的 grant。
    #[serde(default)]
    grants: BTreeMap<String, String>,
    #[serde(default)]
    disabled: Vec<String>,
}

/// 同意记录的键。开发态带上目录：换个工作区放一个同名应用，不能沿用上一个的同意。
fn state_key(source: Source, app_dir: &Path) -> String {
    match source {
        Source::User => format!("user:{}", file_name(app_dir)),
        Source::Workspace => format!("workspace:{}", app_dir.display()),
    }
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn load_state(roots: &Roots) -> State {
    fs::read_to_string(roots.state_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_state(roots: &Roots, state: &State) -> Result<(), String> {
    fs::create_dir_all(&roots.data).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    write_atomic(&roots.state_path(), text.as_bytes())
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// 开发态的这一份是不是已经**原样**装好了。是 → 它让位给安装版：否则点了「安装」界面上什么都
/// 不变（开发态还盖着），用户只会以为按钮坏了。之后 agent 再改开发态，两份不一样了，它才重新盖上来。
fn installed_as_is(roots: &Roots, dev_dir: &Path) -> bool {
    let installed = roots.user_apps.join(file_name(dev_dir));
    installed.join(MANIFEST_FILE).is_file() && same_content(dev_dir, &installed)
}

/// 两个应用目录内容是否一样（点号开头的条目不算，同 [`revision`]）。结果按两边的「最新修改时刻 +
/// 文件名与大小」记住：`list` 是被轮询的，不能每轮把文件内容读一遍。（光看修改时刻不够：
/// 删一个文件、或同一毫秒里加一个文件，它不变。）
fn same_content(a: &Path, b: &Path) -> bool {
    use std::sync::{Mutex, PoisonError};
    type Key = (PathBuf, PathBuf);
    type Stamp = (u64, u64, BTreeMap<PathBuf, u64>, BTreeMap<PathBuf, u64>);
    static CACHE: Mutex<BTreeMap<Key, (Stamp, bool)>> = Mutex::new(BTreeMap::new());
    let key = (a.to_path_buf(), b.to_path_buf());
    let (fa, fb) = (files_of(a), files_of(b));
    let stamp: Stamp = (revision(a), revision(b), fa.clone(), fb.clone());
    if let Some((before, same)) = CACHE.lock().unwrap_or_else(PoisonError::into_inner).get(&key) {
        if *before == stamp {
            return *same;
        }
    }
    let same = fa == fb
        && fa.keys().all(|rel| match (fs::read(a.join(rel)), fs::read(b.join(rel))) {
            (Ok(x), Ok(y)) => x == y,
            _ => false,
        });
    CACHE.lock().unwrap_or_else(PoisonError::into_inner).insert(key, (stamp, same));
    same
}

/// 目录里的文件：相对路径 → 大小。
fn files_of(root: &Path) -> BTreeMap<PathBuf, u64> {
    let mut files = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with('.') || files.len() > MAX_REVISION_FILES {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(entry.path());
            } else if let Ok(rel) = entry.path().strip_prefix(root) {
                files.insert(rel.to_path_buf(), meta.len());
            }
        }
    }
    files
}

/// 全部应用。同 id 时开发态盖过已安装的（正在改的那份才是用户想看的）——除非两份一模一样。
pub fn list(roots: &Roots) -> Vec<AppInfo> {
    let state = load_state(roots);
    let mut by_id: BTreeMap<String, AppInfo> = BTreeMap::new();
    // 倒着放：优先级高的后写，盖掉同 id 的
    for (source, dir) in roots.app_dirs().into_iter().rev() {
        for app_dir in subdirs(dir) {
            if source == Source::Workspace && installed_as_is(roots, &app_dir) {
                continue;
            }
            let mut info = describe(&app_dir, source, &state);
            info.installed = roots.user_apps.join(file_name(&app_dir)).join(MANIFEST_FILE).is_file();
            info.always_visible = source == Source::User || roots.daily_apps.as_deref() == Some(dir);
            by_id.insert(info.id.clone(), info);
        }
    }
    by_id.into_values().collect()
}

fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && !file_name(p).starts_with('.'))
        .collect();
    dirs.sort();
    dirs
}

fn read_manifest(app_dir: &Path) -> Result<Manifest, String> {
    let text = fs::read_to_string(app_dir.join(MANIFEST_FILE)).map_err(|e| format!("读不到 {MANIFEST_FILE}：{e}"))?;
    manifest::parse(&text, &file_name(app_dir))
}

fn describe(app_dir: &Path, source: Source, state: &State) -> AppInfo {
    let key = state_key(source, app_dir);
    let enabled = !state.disabled.contains(&key);
    let revision = revision(app_dir);
    match read_manifest(app_dir) {
        Ok(m) => {
            let grant = m.grant();
            AppInfo {
                consented: state.grants.get(&key) == Some(&grant),
                id: m.id,
                name: m.name.trim().to_string(),
                version: m.version,
                icon: m.icon,
                placement: m.panel.placement,
                entry: m.panel.entry,
                permissions: m.permissions,
                has_server: m.server.is_some(),
                source,
                enabled,
                grant,
                revision,
                read_only_tools: Vec::new(),
                installed: false,
                always_visible: false,
                error: None,
            }
        }
        Err(error) => AppInfo {
            id: file_name(app_dir),
            name: file_name(app_dir),
            version: String::new(),
            icon: None,
            placement: Placement::Right,
            entry: String::new(),
            permissions: Vec::new(),
            has_server: false,
            source,
            enabled,
            consented: false,
            grant: String::new(),
            revision,
            read_only_tools: Vec::new(),
            installed: false,
            always_visible: false,
            error: Some(error),
        },
    }
}

/// 应用目录里最新的修改时刻（毫秒）。不跟符号链接；点号开头的条目不算（开发日志、编辑器临时文件）。
pub fn revision(app_dir: &Path) -> u64 {
    let mut latest = 0u64;
    let mut seen = 0usize;
    let mut stack = vec![app_dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            seen += 1;
            if seen > MAX_REVISION_FILES {
                return latest;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(entry.path());
            } else if let Ok(at) = meta.modified() {
                let ms = at.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
                latest = latest.max(ms);
            }
        }
    }
    latest
}

/// 一个已定位的应用：目录、清单与它在同意记录里的键。
pub struct Located {
    pub dir: PathBuf,
    pub manifest: Manifest,
    pub source: Source,
    key: String,
}

/// 按 id 找应用（开发态优先，同 [`list`]）。清单坏了算找不到。
pub fn locate(roots: &Roots, id: &str) -> Result<Located, String> {
    // id 会拼进路径：先按清单的 id 规则把关，再去碰磁盘
    manifest::safe_rel(id).map_err(|_| format!("应用 id「{id}」不合法"))?;
    if id.contains('/') {
        return Err(format!("应用 id「{id}」不合法"));
    }
    for (source, root) in roots.app_dirs() {
        let dir = root.join(id);
        if dir.join(MANIFEST_FILE).is_file() && !(source == Source::Workspace && installed_as_is(roots, &dir)) {
            let manifest = read_manifest(&dir)?;
            let key = state_key(source, &dir);
            return Ok(Located { dir, manifest, source, key });
        }
    }
    Err(format!("没有应用「{id}」"))
}

impl Located {
    pub fn usable(&self, roots: &Roots) -> Result<(), String> {
        let state = load_state(roots);
        if state.disabled.contains(&self.key) {
            return Err(format!("应用「{}」已禁用", self.manifest.id));
        }
        if state.grants.get(&self.key) != Some(&self.manifest.grant()) {
            return Err(format!("应用「{}」还没有得到用户同意", self.manifest.id));
        }
        Ok(())
    }
}

impl Located {
    /// 怎么拉起它的后端；清单没写 `server` 就是 `None`。
    pub fn server_spec(&self, roots: &Roots, node: &Path) -> Option<Spec> {
        let server = self.manifest.server.as_ref()?;
        Some(Spec {
            id: self.manifest.id.clone(),
            program: node.to_path_buf(),
            args: vec![self.dir.join(&server.entry).to_string_lossy().into_owned()],
            cwd: self.dir.clone(),
            env: vec![
                ("AIDE_APP_ID".into(), self.manifest.id.clone()),
                ("AIDE_APP_DATA".into(), roots.data_dir(&self.manifest.id).to_string_lossy().into_owned()),
            ],
            revision: revision(&self.dir),
        })
    }

    /// 往开发日志追加一行（只对开发态应用；写失败不算事）。
    pub fn dev_log(&self, line: &str) {
        if self.source == Source::Workspace {
            append_dev_log(&self.dir, line);
        }
    }
}

pub fn append_dev_log(app_dir: &Path, line: &str) {
    use std::io::Write;
    let path = app_dir.join(DEV_LOG);
    // 太长就留后一半：agent 关心的是最近发生了什么
    if fs::metadata(&path).is_ok_and(|m| m.len() > MAX_DEV_LOG) {
        if let Ok(bytes) = fs::read(&path) {
            let keep = &bytes[bytes.len() / 2..];
            let start = keep.iter().position(|b| *b == b'\n').map_or(0, |i| i + 1);
            let _ = fs::write(&path, &keep[start..]);
        }
    }
    let secs = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) % 86_400;
    let stamp = format!("{:02}:{:02}:{:02}Z", secs / 3600, secs % 3600 / 60, secs % 60);
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "[{stamp}] {}", line.replace('\n', "\n    "));
    }
}

/// 后端的 `tools/list` 结果里，agent 调用时可以免确认的工具名：自己标了 `readOnlyHint` 的那些。
///
/// **只对安装版成立**。开发态应用的后端代码是 agent 自己在改的——认它自称的「只读」，等于
/// agent 写一个标成只读的工具再自己调，绕过所有确认拿到任意代码执行。所以开发态一律逐次确认；
/// 「安装」是用户的显式动作，把代码定格在 agent 写不到的地方（`~/.aide/apps`）之后才认。
pub fn read_only_tools(source: Source, tools_list: &serde_json::Value) -> Vec<String> {
    if source != Source::User {
        return Vec::new();
    }
    let Some(tools) = tools_list.get("tools").and_then(|t| t.as_array()) else { return Vec::new() };
    tools
        .iter()
        .filter(|t| t.pointer("/annotations/readOnlyHint").and_then(|v| v.as_bool()) == Some(true))
        .filter_map(|t| t.get("name").and_then(|n| n.as_str()))
        // 工具名会拼进权限规则（mcp__app-<id>__<名>）：只认规矩的名字
        .filter(|name| !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
        .map(str::to_string)
        .collect()
}

/// 要挂进 agent 会话的应用后端：已同意、已启用、清单带 `server` 的应用，每个一条。
/// 开发态的带上工作区根——只有在那个工作区里的会话才挂它。
/// `read_only` 给出某个应用免确认的工具（命令层从后端问来，见 [`read_only_tools`]）。
pub fn mcp_entries(roots: &Roots, node: &Path, read_only: &dyn Fn(&str) -> Vec<String>) -> Vec<serde_json::Value> {
    list(roots)
        .into_iter()
        .filter(|a| a.error.is_none() && a.enabled && a.consented && a.has_server)
        .filter_map(|a| {
            let app = locate(roots, &a.id).ok()?;
            let spec = app.server_spec(roots, node)?;
            let env: BTreeMap<String, String> = spec.env.into_iter().collect();
            Some(serde_json::json!({
                "name": format!("app-{}", a.id),
                // 开发态只挂给它所在工作区的会话：`<工作区>/.aide/apps/<id>` 往上三级
                "workspace": (a.source == Source::Workspace)
                    .then(|| app.dir.ancestors().nth(3).map(|r| r.to_string_lossy().into_owned()))
                    .flatten(),
                "config": { "type": "stdio", "command": spec.program, "args": spec.args, "env": env },
                "readOnlyTools": read_only(&a.id),
            }))
        })
        .collect()
}

/// 把 [`mcp_entries`] 落成 sidecar 读的文件（内容没变就不写）。同意与否只在 Host 这边判，
/// sidecar 只读结果——不在 TS 里再实现一遍同意逻辑。
pub fn write_mcp_file(roots: &Roots, entries: &[serde_json::Value]) -> Result<(), String> {
    let text = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?;
    let path = roots.data.join(MCP_FILE);
    if fs::read_to_string(&path).is_ok_and(|current| current == text) {
        return Ok(());
    }
    fs::create_dir_all(&roots.data).map_err(|e| e.to_string())?;
    write_atomic(&path, text.as_bytes())
}

/// 删掉用户**眼前这一个**应用，返回删的是哪一种。应用的数据（`app-data/<id>`）留着，重装还在。
///
/// - 眼前是安装版：删 `~/.aide/apps/<id>`，**连同与它一模一样的开发态副本**——那些副本平时被安装版
///   盖着，不一起删的话，卸载完它立刻以「开发中」的样子冒回来，用户只会觉得没卸掉（2026-10-10 真机踩到）。
/// - 眼前是开发态（没装过，或装过又改了）：只删这一份开发态；有安装版的话由它接管。
///
/// 清单坏了的也删得掉（不走 `locate`）：否则 agent 写坏的应用会一直赖在侧栏上。
pub fn uninstall(roots: &Roots, id: &str) -> Result<Source, String> {
    manifest::safe_rel(id).ok().filter(|_| !id.contains('/')).ok_or(format!("应用 id「{id}」不合法"))?;
    let shown = roots
        .app_dirs()
        .into_iter()
        .map(|(source, root)| (source, root.join(id)))
        .find(|(source, dir)| dir.is_dir() && !(*source == Source::Workspace && installed_as_is(roots, dir)));
    let Some((source, dir)) = shown else {
        return Err(format!("没有应用「{id}」"));
    };
    let mut doomed = vec![(source, dir)];
    if source == Source::User {
        let copies = roots.app_dirs().into_iter().filter(|(s, _)| *s == Source::Workspace);
        doomed.extend(copies.map(|(s, root)| (s, root.join(id))).filter(|(_, d)| d.is_dir() && installed_as_is(roots, d)));
    }
    let mut state = load_state(roots);
    // 先删副本、最后删安装版：中途失败时安装版还在，状态是自洽的
    for (source, dir) in doomed.iter().rev() {
        fs::remove_dir_all(dir).map_err(|e| format!("删不掉 {}：{e}", dir.display()))?;
        let key = state_key(*source, dir);
        state.grants.remove(&key);
        state.disabled.retain(|k| k != &key);
    }
    save_state(roots, &state)?;
    Ok(source)
}

/// 记下用户的同意。`grant` 必须等于清单**此刻**的 grant：用户同意的是他看到的那一份，
/// 弹窗开着的时候清单被改了（多申请了权限）就不算数。
pub fn consent(roots: &Roots, id: &str, grant: &str) -> Result<(), String> {
    let app = locate(roots, id)?;
    if app.manifest.grant() != grant {
        return Err("应用的权限在确认期间变了，请重新确认".into());
    }
    let mut state = load_state(roots);
    state.grants.insert(app.key, grant.to_string());
    save_state(roots, &state)
}

pub fn set_enabled(roots: &Roots, id: &str, enabled: bool) -> Result<(), String> {
    let app = locate(roots, id)?;
    let mut state = load_state(roots);
    state.disabled.retain(|k| k != &app.key);
    if !enabled {
        state.disabled.push(app.key);
    }
    save_state(roots, &state)
}

/// 读应用目录里的一个文件。未经同意只给图标（rail 与确认弹窗要显示它）；
/// 其余一律等用户点了同意——界面代码不能在同意前就跑起来。
pub fn asset(roots: &Roots, id: &str, path: &str) -> Result<Vec<u8>, String> {
    let app = locate(roots, id)?;
    manifest::safe_rel(path)?;
    if app.manifest.icon.as_deref() != Some(path) {
        app.usable(roots)?;
    }
    let file = app.dir.join(path);
    // 符号链接可以指到目录外：解析后必须仍在应用目录内
    let real = file.canonicalize().map_err(|_| format!("应用「{id}」里没有 {path}"))?;
    let root = app.dir.canonicalize().map_err(|e| e.to_string())?;
    if !real.starts_with(&root) {
        return Err(format!("{path} 指到了应用目录之外"));
    }
    let meta = fs::metadata(&real).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(format!("{path} 不是文件"));
    }
    if meta.len() > MAX_ASSET_BYTES {
        return Err(format!("{path} 超过 {} MB 上限", MAX_ASSET_BYTES / 1024 / 1024));
    }
    fs::read(&real).map_err(|e| e.to_string())
}

/// 把开发态应用装成用户级：整目录复制到 `~/.aide/apps/<id>`（先落临时目录再换上，失败不留半截）。
/// 装完要重新同意——同意记录按来源分开记。
pub fn install(roots: &Roots, id: &str) -> Result<(), String> {
    let app = locate(roots, id)?;
    if app.source != Source::Workspace {
        return Err(format!("应用「{id}」已经是安装版"));
    }
    fs::create_dir_all(&roots.user_apps).map_err(|e| e.to_string())?;
    let staging = roots.user_apps.join(format!(".{id}.installing"));
    let _ = fs::remove_dir_all(&staging);
    let copied = copy_tree(&app.dir, &staging);
    if let Err(e) = copied {
        let _ = fs::remove_dir_all(&staging);
        return Err(e);
    }
    let target = roots.user_apps.join(id);
    let retired = roots.user_apps.join(format!(".{id}.retired"));
    let _ = fs::remove_dir_all(&retired);
    let had_old = target.exists();
    if had_old {
        fs::rename(&target, &retired).map_err(|e| e.to_string())?;
    }
    if let Err(e) = fs::rename(&staging, &target) {
        if had_old {
            let _ = fs::rename(&retired, &target);
        }
        return Err(e.to_string());
    }
    let _ = fs::remove_dir_all(&retired);
    // 没有后端的应用：用户在开发态同意过同一份权限，点「安装」又是他自己的动作，不再问一遍。
    // 带后端的不带过去——安装版的只读工具免确认，这一条得让他在同意卡片上看见。
    if app.manifest.server.is_none() {
        let grant = app.manifest.grant();
        let mut state = load_state(roots);
        if state.grants.get(&app.key) == Some(&grant) {
            state.grants.insert(state_key(Source::User, &target), grant);
            save_state(roots, &state)?;
        }
    }
    Ok(())
}

/// 复制普通文件与目录；符号链接跳过（不把目录外的东西带进安装版）。
fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        // 开发日志是开发态的东西，不带进安装版
        if entry.file_name() == DEV_LOG {
            continue;
        }
        let dest = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &dest)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &dest).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    pub(crate) fn temp_roots(tag: &str) -> Roots {
        let base = std::env::temp_dir().join(format!(
            "aide_apps_{tag}_{}_{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&base);
        let roots = Roots {
            user_apps: base.join("user"),
            workspace_apps: Some(base.join("wsroot").join(".aide").join("apps")),
            daily_apps: None,
            workspace_root: Some(base.join("wsroot")),
            data: base.join("data"),
        };
        fs::create_dir_all(&roots.user_apps).unwrap();
        fs::create_dir_all(roots.workspace_apps.as_ref().unwrap()).unwrap();
        fs::create_dir_all(roots.workspace_root.as_ref().unwrap()).unwrap();
        roots
    }

    pub(crate) fn write_app(root: &Path, id: &str, permissions: &[&str]) -> PathBuf {
        let dir = root.join(id);
        fs::create_dir_all(dir.join("ui")).unwrap();
        let perms: Vec<String> = permissions.iter().map(|p| format!("\"{p}\"")).collect();
        fs::write(
            dir.join(MANIFEST_FILE),
            format!(
                r#"{{"id":"{id}","name":"{id}","version":"0.1.0","icon":"ui/icon.svg","panel":{{"entry":"ui/index.html"}},"permissions":[{}]}}"#,
                perms.join(",")
            ),
        )
        .unwrap();
        fs::write(dir.join("ui/index.html"), "<h1>hi</h1>").unwrap();
        fs::write(dir.join("ui/icon.svg"), "<svg/>").unwrap();
        dir
    }

    fn one(roots: &Roots, id: &str) -> AppInfo {
        list(roots).into_iter().find(|a| a.id == id).unwrap()
    }

    #[test]
    fn lists_apps_and_a_workspace_copy_shadows_the_installed_one() {
        let roots = temp_roots("list");
        write_app(&roots.user_apps, "snake", &[]);
        write_app(&roots.user_apps, "notes", &["storage"]);
        let dev = write_app(roots.workspace_apps.as_ref().unwrap(), "snake", &[]);
        fs::write(dev.join("ui/index.html"), "<h1>edited</h1>").unwrap();

        let apps = list(&roots);
        assert_eq!(apps.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["notes", "snake"]);
        assert_eq!(one(&roots, "snake").source, Source::Workspace);
        assert!(one(&roots, "snake").installed);
        assert_eq!(one(&roots, "notes").source, Source::User);
        assert!(one(&roots, "notes").revision > 0);
    }

    #[test]
    fn a_broken_manifest_is_listed_with_its_error() {
        let roots = temp_roots("broken");
        let dir = roots.user_apps.join("oops");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(MANIFEST_FILE), "{ not json").unwrap();

        let app = one(&roots, "oops");
        assert!(app.error.unwrap().contains("解析失败"));
        assert!(!app.consented);
        assert!(locate(&roots, "oops").is_err());
    }

    #[test]
    fn the_daily_dir_is_scanned_too_and_the_active_workspace_wins_on_a_clash() {
        let mut roots = temp_roots("daily");
        let daily = roots.user_apps.parent().unwrap().join("daily").join(".aide").join("apps");
        fs::create_dir_all(&daily).unwrap();
        write_app(&daily, "timer", &[]);
        write_app(&daily, "snake", &[]);
        write_app(roots.workspace_apps.as_ref().unwrap(), "snake", &[]);
        roots.daily_apps = Some(daily.clone());

        let timer = locate(&roots, "timer").unwrap();
        assert_eq!((timer.source, timer.dir.clone()), (Source::Workspace, daily.join("timer")));
        assert_eq!(one(&roots, "timer").source, Source::Workspace);
        // 日常目录里的到哪都看得见；项目里的不是。活动工作区就是日常目录时也算（并且只扫一遍）
        assert!(one(&roots, "timer").always_visible);
        assert!(!one(&roots, "snake").always_visible);
        let mut in_daily = roots.clone();
        in_daily.workspace_apps = in_daily.daily_apps.clone();
        assert!(one(&in_daily, "snake").always_visible);
        assert_eq!(in_daily.app_dirs().len(), 2);
        assert_eq!(locate(&roots, "snake").unwrap().dir, roots.workspace_apps.as_ref().unwrap().join("snake"));
        assert_eq!(list(&roots).len(), 2);
    }

    #[test]
    fn an_untrusted_workspace_contributes_nothing() {
        let mut roots = temp_roots("untrusted");
        write_app(roots.workspace_apps.as_ref().unwrap(), "snake", &[]);
        roots.workspace_apps = None;
        assert!(list(&roots).is_empty());
        assert!(locate(&roots, "snake").is_err());
    }

    #[test]
    fn nothing_but_the_icon_is_served_before_consent() {
        let roots = temp_roots("consent");
        write_app(&roots.user_apps, "snake", &[]);

        assert_eq!(asset(&roots, "snake", "ui/icon.svg").unwrap(), b"<svg/>");
        assert!(asset(&roots, "snake", "ui/index.html").unwrap_err().contains("同意"));

        let grant = one(&roots, "snake").grant;
        consent(&roots, "snake", &grant).unwrap();
        assert!(one(&roots, "snake").consented);
        assert_eq!(asset(&roots, "snake", "ui/index.html").unwrap(), b"<h1>hi</h1>");
    }

    #[test]
    fn asking_for_more_permissions_voids_the_consent() {
        let roots = temp_roots("regrant");
        write_app(&roots.user_apps, "notes", &["storage"]);
        let grant = one(&roots, "notes").grant;
        consent(&roots, "notes", &grant).unwrap();

        write_app(&roots.user_apps, "notes", &["storage", "net"]);
        assert!(!one(&roots, "notes").consented);
        assert!(asset(&roots, "notes", "ui/index.html").is_err());
        // 用户同意的是旧的那一份：拿旧 grant 来确认不算数
        assert!(consent(&roots, "notes", &grant).unwrap_err().contains("变了"));
    }

    #[test]
    fn installing_hands_over_to_the_installed_copy_until_the_dev_copy_changes() {
        let roots = temp_roots("handover");
        let dev = write_app(roots.workspace_apps.as_ref().unwrap(), "snake", &["storage"]);
        append_dev_log(&dev, "manifest: ok");
        let grant = one(&roots, "snake").grant;
        consent(&roots, "snake", &grant).unwrap();

        install(&roots, "snake").unwrap();
        // 开发态还在，但两份一样：界面上是安装版，同意也带过来了（没有后端）
        let installed = one(&roots, "snake");
        assert_eq!((installed.source, installed.consented, installed.installed), (Source::User, true, true));
        assert_eq!(locate(&roots, "snake").unwrap().source, Source::User);
        assert!(!roots.user_apps.join("snake").join(DEV_LOG).exists());

        // agent 接着改开发态：它重新盖上来，并且知道自己有个安装版
        fs::write(dev.join("ui/extra.js"), "1").unwrap();
        let edited = one(&roots, "snake");
        assert_eq!((edited.source, edited.installed), (Source::Workspace, true));
        install(&roots, "snake").unwrap();
        assert_eq!(one(&roots, "snake").source, Source::User);
        assert!(roots.user_apps.join("snake/ui/extra.js").is_file());
    }

    #[test]
    fn installing_an_app_with_a_backend_asks_for_consent_again() {
        let roots = temp_roots("carry");
        write_server_app(roots.workspace_apps.as_ref().unwrap(), "db");
        let grant = one(&roots, "db").grant;
        consent(&roots, "db", &grant).unwrap();

        install(&roots, "db").unwrap();
        let installed = one(&roots, "db");
        assert_eq!((installed.source, installed.consented), (Source::User, false));
    }

    #[test]
    fn a_disabled_app_serves_nothing_until_enabled_again() {
        let roots = temp_roots("disable");
        write_app(&roots.user_apps, "snake", &[]);
        let grant = one(&roots, "snake").grant;
        consent(&roots, "snake", &grant).unwrap();

        set_enabled(&roots, "snake", false).unwrap();
        assert!(!one(&roots, "snake").enabled);
        assert!(asset(&roots, "snake", "ui/index.html").unwrap_err().contains("禁用"));

        set_enabled(&roots, "snake", true).unwrap();
        assert!(asset(&roots, "snake", "ui/index.html").is_ok());
    }

    #[test]
    fn assets_cannot_leave_the_app_directory() {
        let roots = temp_roots("escape");
        write_app(&roots.user_apps, "snake", &[]);
        let grant = one(&roots, "snake").grant;
        consent(&roots, "snake", &grant).unwrap();
        fs::write(roots.user_apps.join("secret.txt"), "top secret").unwrap();

        for path in ["../secret.txt", "/etc/passwd", "ui/../../secret.txt", "ui\\..\\..\\secret.txt"] {
            assert!(asset(&roots, "snake", path).is_err(), "{path} should be refused");
        }
        for id in ["../user", "snake/ui", "", "."] {
            assert!(asset(&roots, id, "ui/index.html").is_err(), "id {id:?} should be refused");
        }
    }

    fn write_server_app(root: &Path, id: &str) {
        let dir = write_app(root, id, &[]);
        fs::create_dir_all(dir.join("server")).unwrap();
        fs::write(dir.join("server/main.mjs"), "// backend").unwrap();
        fs::write(
            dir.join(MANIFEST_FILE),
            format!(r#"{{"id":"{id}","name":"{id}","version":"1","panel":{{"entry":"ui/index.html"}},"server":{{"entry":"server/main.mjs"}}}}"#),
        )
        .unwrap();
    }

    #[test]
    fn only_consented_backends_reach_agent_sessions() {
        let roots = temp_roots("mcp");
        write_server_app(&roots.user_apps, "db");
        write_server_app(roots.workspace_apps.as_ref().unwrap(), "dev");
        write_app(&roots.user_apps, "snake", &[]);
        let node = Path::new("/opt/node");
        let none = |_: &str| Vec::new();
        assert!(mcp_entries(&roots, node, &none).is_empty());

        for id in ["db", "dev", "snake"] {
            let grant = one(&roots, id).grant;
            consent(&roots, id, &grant).unwrap();
        }
        let entries = mcp_entries(&roots, node, &|id| if id == "db" { vec!["list_history".to_string()] } else { Vec::new() });
        assert_eq!(entries[0]["readOnlyTools"], serde_json::json!(["list_history"]));
        assert_eq!(entries[1]["readOnlyTools"], serde_json::json!([]));
        let names: Vec<&str> = entries.iter().map(|e| e["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["app-db", "app-dev"]);
        assert_eq!(entries[0]["workspace"], serde_json::Value::Null);
        assert!(entries[1]["workspace"].as_str().unwrap().ends_with("wsroot"));
        assert_eq!(entries[0]["config"]["command"], "/opt/node");
        assert!(entries[0]["config"]["args"][0].as_str().unwrap().ends_with("main.mjs"));
        assert_eq!(entries[0]["config"]["env"]["AIDE_APP_ID"], "db");

        set_enabled(&roots, "db", false).unwrap();
        assert_eq!(mcp_entries(&roots, node, &none).len(), 1);

        write_mcp_file(&roots, &entries).unwrap();
        assert!(fs::read_to_string(roots.data.join(MCP_FILE)).unwrap().contains("app-db"));
    }

    #[test]
    fn only_installed_apps_get_their_read_only_tools_honoured() {
        let tools = serde_json::json!({ "tools": [
            { "name": "list_history", "annotations": { "readOnlyHint": true } },
            { "name": "send_request" },
            { "name": "drop_table", "annotations": { "readOnlyHint": false } },
            { "name": "bad name!", "annotations": { "readOnlyHint": true } },
            { "annotations": { "readOnlyHint": true } },
        ]});
        assert_eq!(read_only_tools(Source::User, &tools), ["list_history"]);
        // 开发态：后端是 agent 在改的，它自称只读不算数
        assert!(read_only_tools(Source::Workspace, &tools).is_empty());
        assert!(read_only_tools(Source::User, &serde_json::json!({})).is_empty());
    }

    #[test]
    fn the_dev_log_is_for_workspace_apps_and_does_not_bump_the_revision() {
        let roots = temp_roots("devlog");
        write_app(roots.workspace_apps.as_ref().unwrap(), "dev", &[]);
        write_app(&roots.user_apps, "installed", &[]);
        let before = one(&roots, "dev").revision;

        locate(&roots, "dev").unwrap().dev_log("ui: TypeError: x is undefined\n  at main.js:3");
        locate(&roots, "installed").unwrap().dev_log("should not be written");

        let log = fs::read_to_string(roots.workspace_apps.as_ref().unwrap().join("dev").join(DEV_LOG)).unwrap();
        assert!(log.contains("TypeError: x is undefined"));
        assert!(!roots.user_apps.join("installed").join(DEV_LOG).exists());
        assert_eq!(one(&roots, "dev").revision, before);
    }

    #[test]
    fn uninstall_removes_the_app_and_its_consent_but_keeps_its_data() {
        let roots = temp_roots("uninstall");
        write_app(&roots.user_apps, "notes", &[]);
        let grant = one(&roots, "notes").grant;
        consent(&roots, "notes", &grant).unwrap();
        fs::create_dir_all(roots.data_dir("notes")).unwrap();
        fs::write(roots.data_dir("notes").join("kv.json"), "{}").unwrap();

        uninstall(&roots, "notes").unwrap();
        assert!(list(&roots).is_empty());
        assert!(roots.data_dir("notes").join("kv.json").is_file());
        // 重装后要重新同意
        write_app(&roots.user_apps, "notes", &[]);
        assert!(!one(&roots, "notes").consented);
        for id in ["../ws", "", "nope"] {
            assert!(uninstall(&roots, id).is_err(), "{id:?}");
        }
    }

    #[test]
    fn uninstalling_takes_the_identical_dev_copy_with_it() {
        let roots = temp_roots("uninstall_all");
        let dev = write_app(roots.workspace_apps.as_ref().unwrap(), "snake", &[]);
        install(&roots, "snake").unwrap();

        assert_eq!(uninstall(&roots, "snake").unwrap(), Source::User);
        assert!(list(&roots).is_empty(), "卸载后不能以「开发中」的样子冒回来");
        assert!(!dev.exists());
    }

    #[test]
    fn removing_an_edited_dev_copy_falls_back_to_the_installed_one() {
        let roots = temp_roots("discard");
        let dev = write_app(roots.workspace_apps.as_ref().unwrap(), "snake", &[]);
        install(&roots, "snake").unwrap();
        fs::write(dev.join("ui/index.html"), "<h1>edited</h1>").unwrap();
        assert_eq!(one(&roots, "snake").source, Source::Workspace);

        assert_eq!(uninstall(&roots, "snake").unwrap(), Source::Workspace);
        assert_eq!(one(&roots, "snake").source, Source::User);
        assert!(!dev.exists());

        // 清单坏了的开发态应用也删得掉
        let broken = roots.workspace_apps.as_ref().unwrap().join("broken");
        fs::create_dir_all(&broken).unwrap();
        fs::write(broken.join(MANIFEST_FILE), "{").unwrap();
        uninstall(&roots, "broken").unwrap();
        assert!(!broken.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_app_directory_is_refused() {
        let roots = temp_roots("symlink");
        let dir = write_app(&roots.user_apps, "snake", &[]);
        let grant = one(&roots, "snake").grant;
        consent(&roots, "snake", &grant).unwrap();
        fs::write(roots.user_apps.join("secret.txt"), "top secret").unwrap();
        std::os::unix::fs::symlink(roots.user_apps.join("secret.txt"), dir.join("ui/leak.txt")).unwrap();

        assert!(asset(&roots, "snake", "ui/leak.txt").unwrap_err().contains("之外"));
    }
}
