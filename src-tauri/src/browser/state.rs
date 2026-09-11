//! `BrowserView` 集合的唯一主人 + Tauri 托管状态包装。
//!
//! 注册成 `Arc<Mutex<..>>`（项目记忆：`State<'_, T>` 引用参数不能跨 `spawn_blocking`，state 注册
//! `Arc<T>` 后 clone 进闭包）。锁选 `std::sync::Mutex`：注册表只持纯领域状态、加锁期内不 await、
//! 引擎 IO 在锁外执行——std 锁足够且避免 async 锁开销（线程模型最终态在 adapter 阶段定）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::browser::port::types::{BrowserView, BrowserViewId};

/// 所有活动浏览器视图的注册表。`BrowserView` 的唯一主人——增删查改只经此（M1）。
#[derive(Debug, Default)]
pub struct BrowserRegistry {
    views: HashMap<BrowserViewId, BrowserView>,
}

impl BrowserRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 入库；若同 id 已存在，返回被替换的旧视图（调用方据此决定是否先 close 引擎侧）。
    pub fn insert(&mut self, view: BrowserView) -> Option<BrowserView> {
        self.views.insert(view.id().clone(), view)
    }

    pub fn get(&self, id: &BrowserViewId) -> Option<&BrowserView> {
        self.views.get(id)
    }

    pub fn get_mut(&mut self, id: &BrowserViewId) -> Option<&mut BrowserView> {
        self.views.get_mut(id)
    }

    pub fn remove(&mut self, id: &BrowserViewId) -> Option<BrowserView> {
        self.views.remove(id)
    }

    pub fn len(&self) -> usize {
        self.views.len()
    }

    pub fn is_empty(&self) -> bool {
        self.views.is_empty()
    }
}

/// Tauri 托管状态。命令层 `.manage(BrowserState::new())` 后取用（接线在原型阶段）。
#[derive(Debug, Default)]
pub struct BrowserState(pub Arc<Mutex<BrowserRegistry>>);

impl BrowserState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(BrowserRegistry::new())))
    }
}
