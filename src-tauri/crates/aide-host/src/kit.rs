//! 目标机上 Host 的随包资源：套件安装目录里的 sidecar（runtime.js，node 跑）+ 套件带的
//! claude CLI。捆绑 LSP 不随远程套件分发——走目标机登录 PATH 上的 server。
//!
//! 进程级设定（[`ServeInit`]）由客户端经 attach 给；守护进程常驻、客户端换了一茬又一茬，
//! 所以**以最近一次 attach 的为准**（只影响之后拉起的 runtime——比如桌面探测到的代理地址
//! 每次连接都可能变）。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{PoisonError, RwLock};

use aide_core::resources::HostResources;
use aide_host::protocol::ServeInit;

pub struct HostKit {
    init: RwLock<ServeInit>,
    install_dir: PathBuf,
}

impl HostKit {
    pub fn new(init: ServeInit, install_dir: PathBuf) -> Self {
        Self { init: RwLock::new(init), install_dir }
    }

    pub fn update(&self, init: ServeInit) {
        *self.init.write().unwrap_or_else(PoisonError::into_inner) = init;
    }

    fn init(&self) -> std::sync::RwLockReadGuard<'_, ServeInit> {
        self.init.read().unwrap_or_else(PoisonError::into_inner)
    }
}

impl HostResources for HostKit {
    fn lsp_dir(&self) -> Option<PathBuf> {
        None
    }

    fn agent_runtime(&self) -> Result<(String, PathBuf), String> {
        let runtime = self.install_dir.join("runtime").join("runtime.js");
        if !runtime.is_file() {
            return Err(format!("sidecar missing: {}", runtime.display()));
        }
        // 进程环境已是登录环境（daemon 启动时切过），`which` 看到的就是用户终端的 PATH。
        let node = self.init().node.clone().unwrap_or_else(|| "node".into());
        let node = crate::login::which(&node, None)
            .ok_or_else(|| format!("找不到 node（{node}）：请在目标机上安装 Node.js"))?;
        Ok((node, runtime))
    }

    fn claude_exe(&self) -> Option<PathBuf> {
        self.init().claude_exe.as_ref().map(PathBuf::from)
    }

    fn agent_env(&self) -> HashMap<String, String> {
        let init = self.init();
        let mut env: HashMap<String, String> = init
            .default_env
            .iter()
            .filter(|(k, _)| std::env::var_os(k).is_none())
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        env.extend(init.env.clone());
        env
    }
}
