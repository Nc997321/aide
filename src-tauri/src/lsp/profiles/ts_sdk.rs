//! TypeScript SDK（tsdk）解析 —— 把 TLS **看不见**的那份 typescript 找出来递给它。
//!
//! TLS 5.3.0 的 typescript 查找顺序（读源码 + 探针实测，2026-09-29）：
//!   1. `initializationOptions.tsserver.path` ← 我们注入的就是这条（优先级最高）
//!   2. **工作区根及其祖先**的 `node_modules/typescript/lib`（`findPathToModule` 逐级向上）
//!   3. `tsserver.fallbackPath`；4. 它自己旁边那份
//!
//! 于是「后端仓库 + `frontend/` 前端」（agri-ai-agent 的形状）**必然失败**：SDK 在子项目
//! 里，2/3/4 一个都看不见 → `initialize` 直接报 "Could not find a valid TypeScript
//! installation"，面板上 TS/JS 行显示启动失败。隔离沙箱实测对照（同一工程形状）：
//! 不注入 → 起不来；注入子项目那份 → TLS 采用 5.7.3，打开 `frontend/src/a.ts` 后
//! `workspace/symbol` 能查到 `frontend/src/b.ts` 里从没打开过的符号。
//!
//! **不重新指 rootUri**（那是最初的设想）：同批实测证明 tsserver 的工程发现本来就跨子目录
//! ——root 指向仓库根时，打开子目录里的文件一样会按最近 tsconfig 加载该工程。缺的只是
//! SDK 这一份运行时，所以修在档案层（`TsProfile::init_options`），manager/registry 零改动。
//!
//! **候选顺序不是随手排的**：注入的优先级比 TLS 自己的搜索还高，所以第一档必须与它的
//! tier2（工作区根 + 祖先）同序——否则 monorepo 里「工作区是子目录、SDK 被 hoist 到祖先」
//! 这种布局，我们会用 PATH 上的全局版本顶掉它本会选对的那份。详见 `candidate_modules`。

use std::path::{Path, PathBuf};

/// 模块目录里的入口文件：TLS 的判据就是它（外加同级的 `package.json` 版本）。
const ENTRY: &str = "lib/tsserver.js";

/// 解析可用的 tsdk，返回 `.../typescript/lib/tsserver.js` 的**绝对路径**。
/// 没有可用的一份 → `None`（不注入，让 TLS 走它自己的链并如实报错）。
pub fn resolve(workspace: &Path) -> Option<PathBuf> {
    candidate_modules(workspace)
        .into_iter()
        .find(|dir| is_usable(dir))
        .map(|dir| dir.join(ENTRY))
}

/// 注入用路径：`resolve` + **平台原生分隔符**。
///
/// ⚠️ 分隔符不是洁癖：TLS 拿到 user setting 后按 `path.sep` 切分反推模块根
/// （`getTypeScriptVersion`：`split(sep)` → 去掉末两段 → 在那个父目录找 `package.json`），
/// **Windows 上传正斜杠路径会被判成 "less than two path components" 而静默忽略**
/// ——探针实测踩过（日志：`Typescript specified through user setting ignored due to
/// invalid path`）。`PathBuf::join` 产出的末几段本来就是 `\`，这里再统一一遍，
/// 免得调用方从别处拼来一个正斜杠路径。
pub fn sdk_entry_path(workspace: &Path) -> Option<String> {
    resolve(workspace).map(|p| native_separators(&p.to_string_lossy()))
}

/// 候选 tsdk **模块目录**（`.../typescript`）。顺序有硬约束：**注入的优先级高于 TLS
/// 自己的搜索**，所以前两档必须与 TLS 的 tier2 同序，否则我们会把它本会选对的那份顶掉。
///
/// 1. **工作区根与它的祖先**（TLS 的 tier2 就是这条链：`findPathToModule` 从工作区根逐级
///    向上）——monorepo 里工作区是子目录、SDK 被 hoist 到祖先时，靠它保持与 TLS 一致
/// 2. **一级子目录**（TLS 看不见；`frontend/` 这类布局靠它）——跳过重目录/点目录，
///    与 `detector`/`vue_plugin` 共用同一份跳过表
/// 3. **PATH 上那个 `tsc`** 对应的 SDK（最后兜底：TLS 的 bundled 在很多机器上无效，
///    全局装的常是 typescript 7.x——Go 重写版没有 `lib/tsserver.js`）
///
/// TLS tier2 里另有 Yarn PnP 的两种布局（`.yarn/sdks`、`.vscode/pnpify`）：不在这里重复，
/// 我们没找到时**不注入**，TLS 会自己去认。
fn candidate_modules(workspace: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = workspace
        .ancestors()
        .map(|base| base.join("node_modules").join("typescript"))
        .collect();
    out.extend(subdir_modules(workspace));
    out.extend(from_path_tsc());
    out
}

/// 一级子目录里的 `node_modules/typescript`（后端仓库 + `frontend/` 前端）。
fn subdir_modules(workspace: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(workspace) else {
        return Vec::new();
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    entries
        .into_iter()
        .filter(|e| e.path().is_dir())
        .filter(|e| !crate::lsp::detector::is_skip_dir(&e.file_name().to_string_lossy()))
        .map(|e| e.path().join("node_modules").join("typescript"))
        .collect()
}

/// PATH 上 `tsc` 对应的 SDK。两种安装布局**各认各的**（按可执行文件名分流，免得把
/// Unix 的假设套到 Windows 的 `.cmd` 上，推出 `<prefix>` 的祖父这种无意义候选）：
/// - Windows npm 全局：`<prefix>/tsc.cmd` → 模块根就在 `<prefix>/node_modules/typescript`
/// - Unix：`<prefix>/bin/tsc` 是指向 `<prefix>/lib/node_modules/typescript/bin/tsc` 的软链
///   → `canonicalize` 后去掉 `bin/tsc` 两段就是模块根
fn from_path_tsc() -> Vec<PathBuf> {
    let Ok(tsc) = which::which("tsc") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let Some(dir) = tsc.parent() {
        out.push(dir.join("node_modules").join("typescript"));
    }
    let is_unix_shim = tsc.extension().is_none() && tsc.file_stem().is_some_and(|s| s == "tsc");
    if is_unix_shim {
        if let Ok(real) = tsc.canonicalize() {
            if let Some(module) = real.parent().and_then(|bin| bin.parent()) {
                out.push(module.to_path_buf());
            }
        }
    }
    out
}

/// 可用判据**与 TLS 对齐**：入口文件在 + 模块根 `package.json` 可解析 + `version` 是
/// **非空字符串**（TLS 的 `getTypeScriptVersion`：文件在、路径按 `path.sep` 切分够两段、
/// 模块根 package.json 的 version 为真值——`if (!desc?.version)`，空串也算没有）。
///
/// 判松了的代价是**静默**的：递一份 TLS 不认的 SDK，它会当作无效 user setting 忽略、
/// 回落到自己那条（看不见子项目的）链——又回到 `initialize` 失败的原始故障态，
/// 而失败原因只写在日志里。所以这里宁可严一点。
fn is_usable(module_dir: &Path) -> bool {
    if !module_dir.join(ENTRY).is_file() {
        return false;
    }
    let Ok(raw) = std::fs::read_to_string(module_dir.join("package.json")) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .is_some_and(|pkg| {
            pkg.get("version")
                .and_then(|v| v.as_str())
                .is_some_and(|v| !v.is_empty())
        })
}

/// 平台原生分隔符（Unix 上是恒等变换）。
fn native_separators(path: &str) -> String {
    path.replace('/', std::path::MAIN_SEPARATOR_STR)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("aide_ts_sdk_{}_{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// 造一份「像 SDK」的目录：判据是两个文件都在，不是目录存在。
    fn install_sdk(module_dir: &Path) {
        fs::create_dir_all(module_dir.join("lib")).unwrap();
        fs::write(module_dir.join("lib/tsserver.js"), "// stub").unwrap();
        fs::write(module_dir.join("package.json"), r#"{"version":"5.9.3"}"#).unwrap();
    }

    /// 子目录里的 SDK 要能找到（agri-ai-agent 的形状），并且**工作区根那份优先**。
    #[test]
    fn resolves_subproject_sdk_and_prefers_root() {
        let ws = tmp("subdir");
        install_sdk(&ws.join("frontend").join("node_modules").join("typescript"));
        assert_eq!(
            resolve(&ws),
            Some(ws.join("frontend").join("node_modules").join("typescript").join(ENTRY)),
            "子项目里的 SDK 该被找到"
        );

        install_sdk(&ws.join("node_modules").join("typescript"));
        assert_eq!(
            resolve(&ws),
            Some(ws.join("node_modules").join("typescript").join(ENTRY)),
            "工作区根那份优先于子目录那份（与 TLS 的偏好一致）"
        );
    }

    /// 目录在但**没有入口文件**（本机全局那份 typescript 7.x 就是这样）→ 不当可用 SDK。
    /// 不能断言 `resolve == None`：本机可能装着可用的全局 tsc（环境会飘）——断言的是
    /// 「那个空壳目录没被当成 SDK」这一条性质本身。
    #[test]
    fn entryless_directory_is_not_a_sdk() {
        let ws = tmp("entryless");
        let bogus = ws.join("node_modules").join("typescript");
        fs::create_dir_all(bogus.join("lib")).unwrap();
        fs::write(bogus.join("package.json"), "{}").unwrap();
        assert_ne!(resolve(&ws), Some(bogus.join(ENTRY)));
    }

    /// 注入路径必须是**平台原生分隔符**（见 `sdk_entry_path` 的 TLS 陷阱）。
    #[test]
    fn injected_path_uses_native_separators() {
        let ws = tmp("separators");
        install_sdk(&ws.join("frontend").join("node_modules").join("typescript"));
        let injected = sdk_entry_path(&ws).expect("该解析到子项目那份");
        assert!(
            injected.ends_with(&format!("lib{}tsserver.js", std::path::MAIN_SEPARATOR)),
            "入口路径形状不对：{injected}"
        );
        let sep_count = injected.matches(std::path::MAIN_SEPARATOR).count();
        assert!(sep_count >= 2, "TLS 按分隔符切分反推模块根，至少要有两段：{injected}");
    }

    /// 档序契约（**与机器无关**）：祖先档是候选表的**前缀**，子目录档紧随其后，PATH 档垫底。
    /// 不是形式主义——注入的优先级高于 TLS 自己的搜索，档序错了会把它本会选对的 SDK 顶掉
    /// （monorepo 子目录工作区、SDK 被 hoist 到祖先的情形）。
    /// 光靠「祖先赢」的行为断言抓不到「PATH 档被提到链首」：本机全局 tsc 是 7.x 空壳、
    /// PATH 档本就无可用项（上一轮审查的变异 B 正是这么活下来的），所以这里断言**结构**。
    #[test]
    fn ancestor_tier_is_the_prefix_of_candidates() {
        let repo = tmp("ancestor");
        install_sdk(&repo.join("node_modules").join("typescript"));
        let nested_ws = repo.join("frontend");
        fs::create_dir_all(nested_ws.join("web")).unwrap();

        let all = candidate_modules(&nested_ws);
        let ancestors: Vec<PathBuf> = nested_ws
            .ancestors()
            .map(|base| base.join("node_modules").join("typescript"))
            .collect();
        assert_eq!(
            &all[..ancestors.len()],
            ancestors.as_slice(),
            "祖先档必须是候选表的前缀：{all:?}"
        );
        let subdir_candidate = nested_ws.join("web").join("node_modules").join("typescript");
        let sub_pos = all
            .iter()
            .position(|p| *p == subdir_candidate)
            .expect("子目录档该在候选里");
        assert!(sub_pos >= ancestors.len(), "子目录档不该插到祖先档前面：{all:?}");

        // 行为面：祖先与子目录都有可用 SDK 时，选中的是祖先那份
        install_sdk(&subdir_candidate);
        assert_eq!(
            resolve(&nested_ws),
            Some(repo.join("node_modules").join("typescript").join(ENTRY)),
            "祖先那份该赢"
        );
    }

    /// 子目录候选要守同一份边界：`node_modules` 与点目录不进去（否则会造出
    /// `<ws>/node_modules/node_modules/typescript` 这种噪音，还要 stat 一堆依赖目录）。
    /// **断言必须能真的变红**：去掉 `subdir_modules` 里的 `is_skip_dir` 过滤 → 本用例失败。
    #[test]
    fn heavy_and_dot_dirs_are_not_scanned() {
        let ws = tmp("heavy");
        fs::create_dir_all(ws.join("node_modules").join("some-pkg")).unwrap();
        fs::create_dir_all(ws.join(".cache").join("x")).unwrap();

        let subdir_derived = subdir_modules(&ws);
        assert!(
            !subdir_derived
                .iter()
                .any(|p| p.starts_with(ws.join("node_modules")) || p.starts_with(ws.join(".cache"))),
            "重目录/点目录不该出候选：{subdir_derived:?}"
        );
        // 反过来也要守住：工作区根**自己**那份 node_modules 是第一档候选，别被一起滤掉
        let all = candidate_modules(&ws);
        assert!(
            all.contains(&ws.join("node_modules").join("typescript")),
            "工作区根那份必须在候选里：{all:?}"
        );
    }

    /// 有 `package.json` 但没有 `version`（或 version 是空串）的不算可用——TLS 要读版本
    /// 才能定 SDK，它用的是真值判断（空串也算没有）。判松了的代价是静默的：递一份它不认的
    /// 路径 → 它忽略并回落到自己那条（看不见子项目的）链 → 又回到「起不来」，原因只在日志里。
    #[test]
    fn versionless_or_empty_version_is_not_a_sdk() {
        let ws = tmp("noversion");
        let dir = ws.join("node_modules").join("typescript");
        fs::create_dir_all(dir.join("lib")).unwrap();
        fs::write(dir.join("lib/tsserver.js"), "// stub").unwrap();

        for pkg in [r#"{}"#, r#"{"version":""}"#] {
            fs::write(dir.join("package.json"), pkg).unwrap();
            assert_ne!(resolve(&ws), Some(dir.join(ENTRY)), "不该把 {pkg} 当 SDK");
        }
    }
}
