//! 宿主资源端口：Core 要起的随包二进制（codegraph runner、agent runtime…）住在哪，
//! 由前门回答——桌面按 Tauri 资源目录 / dev 源码树解析，aide-host 按目标机上的 Host 目录。
//!
//! 每次调用现查（不在启动时快照）：dev 下 runner 可能在应用启动后才构建出来。

use std::path::PathBuf;

pub trait HostResources: Send + Sync + 'static {
    /// codegraph runner 可执行文件（已剥 Windows verbatim 前缀，可直接交给子进程）。
    fn codegraph_runner(&self) -> Result<PathBuf, String>;

    /// runner 本地 ONNX 模型目录（经 `AIDE_CODEGRAPH_MODEL_DIR` 递给 runner）；
    /// None = 不设，runner 自己回退（dev 源码树）。
    fn codegraph_model_dir(&self) -> Option<PathBuf>;

    /// 随包 LSP 目录（`<资源>/lsp`：捆绑的语言服务器、lombok.jar）；None = 没有随包 LSP。
    fn lsp_dir(&self) -> Option<PathBuf>;

    /// agent runtime 的启动命令 `(程序, 首个参数)`：dev = `(node, runtime.js)`，release =
    /// `(aide-agent, 空)`。首个参数为空就不传。路径已剥 verbatim 前缀（交给子进程的）。
    fn agent_runtime(&self) -> Result<(String, PathBuf), String>;

    /// 原生 claude CLI（经 `AIDE_CLAUDE_EXE` 递给 sidecar）；None = 不设。
    fn claude_exe(&self) -> Option<PathBuf>;

    /// Host 额外给 sidecar 的进程级 env（在 provider 参数之前写入）。桌面 = 无（sidecar 继承
    /// 桌面进程环境）；远程 Host = 桌面随连接带来的工具开关 / 代理兜底。
    fn agent_env(&self) -> std::collections::HashMap<String, String> {
        Default::default()
    }
}

/// 什么随包资源都没有的 Host（测试 / 尚未随套件分发该组件的远程 Host）。
/// 如实报错，不静默降级。
pub struct NoResources;

impl HostResources for NoResources {
    fn codegraph_runner(&self) -> Result<PathBuf, String> {
        Err("codegraph runner is not bundled with this host".into())
    }

    fn codegraph_model_dir(&self) -> Option<PathBuf> {
        None
    }

    fn lsp_dir(&self) -> Option<PathBuf> {
        None
    }

    fn agent_runtime(&self) -> Result<(String, PathBuf), String> {
        Err("agent runtime is not bundled with this host".into())
    }

    fn claude_exe(&self) -> Option<PathBuf> {
        None
    }
}
