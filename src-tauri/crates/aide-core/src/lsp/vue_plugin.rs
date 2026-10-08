//! Vue 的 TypeScript 支持：解析 `@vue/typescript-plugin`（tsserver 插件形态）。
//!
//! **为什么是插件、不是 `vue-language-server`**：后者是 proxy——它把请求
//! `sendNotification('tsserver/request')` 发给**客户端**、等客户端回 `tsserver/response`，
//! 宿主不桥接就一条请求都不答。实测（2026-09-19）：健康的 Volar 在 72KB 的 `.vue` 上
//! 零响应 125.9s，在 **10 行**的最小 Vue 项目上同样零响应 60s——不是仓库大小的问题，
//! 是架构。插件形态则跑在 aide **已有**的 TS 服务器里，不新增任何进程。
//!
//! 实测对照（真仓库 `applyTheme` 的 references，`src/themes/apply.ts:8:17`）：
//!
//! | 配置 | 结果 |
//! |---|---|
//! | 不装插件 | count=1（只有定义自己） |
//! | 装插件、默认 useSyntaxServer | count=1 ← 骗人的一档 |
//! | 装插件 + `useSyntaxServer:"never"` | **count=7**（App.vue×3 + SettingsPanel.vue×2 + themes/index.ts + 定义），与 grep 真值逐条吻合 |
//!
//! 详见 `docs/superpowers/spikes/2026-09-19-lsp-agent-tools/README.md` §5。
//!
//! **探不到就不启用**：插件的有无是环境事实，它带一串运行时依赖（`@volar/typescript` /
//! `@vue/language-core` / `vue-component-meta`…），不适合随 aide 分发。探不到 = 退回今天的
//! 现状（TS 服务器看不见 `.vue`），不是错误——但**绝不能**为它影响普通 TS 工作区。

use std::path::{Path, PathBuf};

/// 插件包名。tsserver 靠 `--globalPlugins <名字>` + `--pluginProbeLocations <目录>` 去找它，
/// 两个值都从这里出，别在别处再写一遍字面量。
pub const PLUGIN_NAME: &str = "@vue/typescript-plugin";

/// 解析插件目录。按下面的顺序逐个探，命中即返回；都不中返回 `None`。
pub fn find(workspace: &str) -> Option<PathBuf> {
    candidates(workspace)
        .into_iter()
        .find(|dir| dir.join("package.json").is_file())
}

/// 该工作区有没有 `.vue` 文件——决定要不要为它付插件的代价。
///
/// 按**扩展名**找（`find_source_with_ext`），不按语言：`.vue` 的服务归属是 TypeScript
/// （见 `detector::from_ext`），而「有没有 .vue 文件」问的是文件形态，是另一件事。
/// 复用同一份**有界**遍历（深度 ≤4、跳过重目录）：只做一次 `is_some()` 判定，找到第一个
/// 就返回，不遍历全仓。Vue 项目的 `.vue` 一般躺在 `src/components/…`（3 层），4 层够。
pub fn has_vue_files(workspace: &str) -> bool {
    crate::lsp::detector::find_source_with_ext(Path::new(workspace), "vue").is_some()
}

/// 候选目录，按「越可能是真值越靠前」排：
/// 1. 项目自己的 `node_modules`（Vue 项目的标准位置，也是唯一有版本保证的那份）
/// 2. 项目内嵌套（npm 会把嵌套依赖装进包自己的 `node_modules`）
/// 3. **一层子目录**里各项目的 `node_modules`（后端仓库 + `frontend/` 前端那种布局，
///    见 `subdir_plugin_dirs`）
/// 4. pnpm 内容寻址布局（`.pnpm/@vue+typescript-plugin@<版本>/node_modules/<包>`）
/// 5. node 可执行文件同级的全局前缀（WinGet / portable / nvm 这类安装方式）
/// 6. Windows npm 的默认全局前缀（`%APPDATA%\npm\node_modules`，扁平与「Volar 内嵌」
///    两种布局都探——后者是 `npm i -g @vue/language-server` 的真实产物）
///
/// 前四条基于**路径推导**（纯函数，单测不依赖本机装没装）；后两条要问环境。
fn candidates(workspace: &str) -> Vec<PathBuf> {
    let ws = Path::new(workspace);
    let mut out = vec![
        ws.join("node_modules").join(PLUGIN_NAME),
        nested(&ws.join("node_modules")),
    ];
    out.extend(subdir_plugin_dirs(ws));
    out.extend(pnpm_plugin_dirs(&ws.join("node_modules")));
    if let Some(node_dir) = crate::lsp::registry::which_native("node").and_then(|n| n.parent().map(PathBuf::from)) {
        out.push(node_dir.join("node_modules").join(PLUGIN_NAME));
        out.push(nested(&node_dir.join("node_modules")));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let npm_root = Path::new(&appdata).join("npm").join("node_modules");
        out.push(npm_root.join(PLUGIN_NAME));
        // 全局装的 Volar 把插件**嵌在自己包里**（npm i -g @vue/language-server 的结果，
        // 本机实测就是 `<npm 全局>/@vue/language-server/node_modules/@vue/typescript-plugin`）
        // ——漏了这一条，「装了插件却永远探不到」，Vue 支持静默不启用。
        out.push(nested(&npm_root));
    }
    out
}

/// npm 嵌套布局：Volar 把插件嵌在自己的 `node_modules` 里。
fn nested(base: &Path) -> PathBuf {
    base.join("@vue")
        .join("language-server")
        .join("node_modules")
        .join(PLUGIN_NAME)
}

/// pnpm 内容寻址布局：`<node_modules>/.pnpm/@vue+typescript-plugin@<版本>/node_modules/<包>`。
/// 根与子项目各查自己那份（pnpm 的工作区根才放 `.pnpm`，子项目也可能自带一份）。
fn pnpm_plugin_dirs(node_modules: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(node_modules.join(".pnpm")) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("@vue+typescript-plugin@"))
        .map(|e| e.path().join("node_modules").join(PLUGIN_NAME))
        .collect()
}

/// 一层子目录里的 `node_modules/@vue/typescript-plugin`：**后端仓库 + 前端子目录**
/// （`frontend/`、`web/`、`client/`…）的布局，插件装在前端项目自己那份 node_modules 里
/// ——agri-ai-agent 就是这个形状，只认工作区根的 node_modules 会漏。
///
/// 与 `detector` 共用一份跳过表（重目录/点目录不进去），按目录名排序保证确定性；
/// **只下钻一层**：`apps/web/` 那种更深的形状要支持得把工作区开到子项目上（本层不做）。
fn subdir_plugin_dirs(ws: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(ws) else {
        return Vec::new();
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    let mut out = Vec::new();
    for entry in entries {
        if !entry.path().is_dir()
            || crate::lsp::detector::is_skip_dir(&entry.file_name().to_string_lossy())
        {
            continue;
        }
        let node_modules = entry.path().join("node_modules");
        out.push(node_modules.join(PLUGIN_NAME));
        // 子项目里装的 Volar 同样可能把插件嵌在自己包内（与全局那条同形）
        out.push(nested(&node_modules));
        out.extend(pnpm_plugin_dirs(&node_modules));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("aide_vue_plugin_{}_{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// 造一个「像插件」的目录（判据是 package.json 存在，不是目录存在）。
    fn install_at(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("package.json"), r#"{"name":"@vue/typescript-plugin"}"#).unwrap();
    }

    #[test]
    fn finds_project_local_install() {
        let ws = tmp("local");
        install_at(&ws.join("node_modules").join(PLUGIN_NAME));
        assert_eq!(
            find(ws.to_str().unwrap()),
            Some(ws.join("node_modules").join(PLUGIN_NAME))
        );
    }

    #[test]
    fn finds_nested_install_under_language_server() {
        let ws = tmp("nested");
        install_at(&ws.join("node_modules").join("@vue").join("language-server").join("node_modules").join(PLUGIN_NAME));
        assert!(find(ws.to_str().unwrap()).is_some(), "npm 嵌套布局没命中");
    }

    /// 子项目自己的 node_modules（后端仓库 + `frontend/` 前端）：agri-ai-agent 的形状。
    #[test]
    fn finds_plugin_in_subproject_node_modules() {
        let ws = tmp("subdir");
        let frontend = ws.join("frontend");
        install_at(&frontend.join("node_modules").join(PLUGIN_NAME));
        assert_eq!(
            find(ws.to_str().unwrap()),
            Some(frontend.join("node_modules").join(PLUGIN_NAME)),
            "工作区根的 node_modules 不存在时，该命中子项目那份"
        );
    }

    /// Windows npm 全局前缀（`%APPDATA%\npm\node_modules`）两种布局都要在候选里：
    /// 扁平那份，以及**全局装的 Volar 把插件嵌在自己包内**那份（本机实测的布局）。
    #[cfg(windows)]
    #[test]
    fn covers_both_global_npm_layouts() {
        // 生产函数对 APPDATA 缺席是安全的（`if let`）；无 profile 的服务环境里跳过本用例
        let Some(appdata) = std::env::var_os("APPDATA") else {
            return;
        };
        let npm_root = Path::new(&appdata).join("npm").join("node_modules");
        let list = candidates(tmp("globalshape").to_str().unwrap());
        assert!(
            list.contains(&npm_root.join(PLUGIN_NAME)),
            "扁平全局布局漏了：{list:?}"
        );
        assert!(
            list.contains(
                &npm_root
                    .join("@vue")
                    .join("language-server")
                    .join("node_modules")
                    .join(PLUGIN_NAME)
            ),
            "嵌套全局布局漏了（装了却探不到 = Vue 支持静默不启用）：{list:?}"
        );
    }

    /// 子项目里的另外两种布局也要探到（与根/全局那两条同形）：Volar 把插件嵌在自己包内、
    /// pnpm 内容寻址。漏了就是「装了却永远探不到」——Vue 支持静默不启用。
    #[test]
    fn finds_all_subproject_layouts() {
        let nested_ws = tmp("subdirnested");
        let frontend = nested_ws.join("frontend");
        let nested_path = frontend
            .join("node_modules")
            .join("@vue")
            .join("language-server")
            .join("node_modules")
            .join(PLUGIN_NAME);
        install_at(&nested_path);
        assert_eq!(find(nested_ws.to_str().unwrap()), Some(nested_path));

        let pnpm_ws = tmp("subdirpnpm");
        let pnpm_path = pnpm_ws
            .join("frontend")
            .join("node_modules")
            .join(".pnpm")
            .join("@vue+typescript-plugin@3.3.11")
            .join("node_modules")
            .join(PLUGIN_NAME);
        install_at(&pnpm_path);
        assert_eq!(find(pnpm_ws.to_str().unwrap()), Some(pnpm_path));
    }

    /// 子目录扫描要守同一份边界：`node_modules` 与点目录不进去（否则要 stat 一堆依赖目录，
    /// 还会造出 `<ws>/node_modules/node_modules/...` 这种噪音候选）。
    #[test]
    fn subdir_scan_skips_heavy_and_dot_dirs() {
        let ws = tmp("subdirskip");
        fs::create_dir_all(ws.join("node_modules").join("some-pkg")).unwrap();
        fs::create_dir_all(ws.join(".cache").join("x")).unwrap();
        let list = candidates(ws.to_str().unwrap());
        let noise = |p: &PathBuf| {
            p.starts_with(ws.join("node_modules").join("some-pkg"))
                || p.starts_with(ws.join(".cache"))
                || p.starts_with(ws.join("node_modules").join("node_modules"))
        };
        assert!(!list.iter().any(noise), "重目录/点目录不该出候选：{list:?}");
    }

    #[test]
    fn finds_pnpm_content_addressed_install() {
        let ws = tmp("pnpm");
        install_at(
            &ws.join("node_modules").join(".pnpm")
                .join("@vue+typescript-plugin@3.3.11")
                .join("node_modules").join(PLUGIN_NAME),
        );
        assert!(find(ws.to_str().unwrap()).is_some(), "pnpm .pnpm 布局没命中");
    }

    /// 只有一个空目录（没有 `package.json`）不算装上了——判据取真值，不猜目录存在。
    ///
    /// **不能断言 `find() == None`**：本机可能装着全局副本（候选 4/5/6），那会让断言
    /// 随环境飘。这里断言的是「空目录没被当成安装」这一条性质本身——结果只要不是那个
    /// 空目录即可。
    #[test]
    fn empty_directory_is_not_an_install() {
        let ws = tmp("empty");
        let empty = ws.join("node_modules").join(PLUGIN_NAME);
        fs::create_dir_all(&empty).unwrap();
        assert_ne!(find(ws.to_str().unwrap()).as_deref(), Some(empty.as_path()));
    }

    /// 工作区里没装时，**不该命中工作区内的任何路径**（全局副本命中是可以的，见上）。
    #[test]
    fn workspace_without_install_never_resolves_inside_itself() {
        let ws = tmp("missing");
        let found = find(ws.to_str().unwrap());
        assert!(
            !found.as_deref().is_some_and(|p| p.starts_with(&ws)),
            "工作区里没装它，却命中了工作区内的 {found:?}"
        );
    }

    /// 候选**顺序**是契约：项目自己那份优先于全局那份（版本跟着项目走，有保证）。
    /// 纯路径推导，不依赖本机装没装。
    #[test]
    fn workspace_candidates_come_before_global_ones() {
        let ws = tmp("order");
        let list = candidates(ws.to_str().unwrap());
        assert_eq!(
            list.first(),
            Some(&ws.join("node_modules").join(PLUGIN_NAME)),
            "第一个候选必须是项目本地那份"
        );
        let last_local = list.iter().rposition(|p| p.starts_with(&ws)).unwrap_or(0);
        let first_global = list.iter().position(|p| !p.starts_with(&ws));
        assert!(
            first_global.is_none_or(|g| last_local < g),
            "全局候选排到了项目候选前面：{list:?}"
        );
    }

    #[test]
    fn has_vue_files_detects_vue_sources() {
        let ws = tmp("hasvue");
        assert!(!has_vue_files(ws.to_str().unwrap()));
        let deep = ws.join("src").join("components").join("Panel");
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("Thing.vue"), "<template><div/></template>").unwrap();
        assert!(has_vue_files(ws.to_str().unwrap()), "src 下 3 层的 .vue 该被找到");
    }

    /// 重目录里的 .vue 不算数——复用 detector 的边界（node_modules 不下钻）。
    #[test]
    fn has_vue_files_ignores_vendor_vue_files() {
        let ws = tmp("vendorvue");
        let vendored = ws.join("node_modules").join("some-lib");
        fs::create_dir_all(&vendored).unwrap();
        fs::write(vendored.join("Comp.vue"), "<template/>").unwrap();
        assert!(!has_vue_files(ws.to_str().unwrap()), "node_modules 里的 .vue 不该触发");
    }
}
