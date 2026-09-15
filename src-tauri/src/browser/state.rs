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
    /// 视图 id 序号。**身份归状态主人**：id 由注册表发（不由 UI 造时间戳），面板、未来的 agent
    /// 工具、任何新消费方拿到的都是同一个可寻址 id；也免掉调用方 id 撞车这类事故。
    next_seq: u64,
}

impl BrowserRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 分配一个视图 id（`browser-<n>`，进程内不复用）。分配后调用方再 `insert` 自己的视图。
    pub fn allocate_id(&mut self) -> BrowserViewId {
        self.next_seq += 1;
        // 生成值恒非空，`try_new` 的守门在此不可能失败。
        BrowserViewId::try_new(format!("browser-{}", self.next_seq))
            .expect("allocate_id 生成的 id 非空")
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
}

/// Tauri 托管状态。命令层 `.manage(BrowserState::new())` 后取用（接线在原型阶段）。
#[derive(Debug, Default)]
pub struct BrowserState(pub Arc<Mutex<BrowserRegistry>>);

impl BrowserState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(BrowserRegistry::new())))
    }
}

#[cfg(test)]
mod state_test {
    use super::*;
    use crate::browser::port::types::{Bounds, Position, Size};

    fn bounds() -> Bounds {
        Bounds::new(Position::new(0.0, 0.0), Size::try_new(10.0, 10.0).unwrap())
    }

    #[test]
    fn allocate_id_is_unique_and_never_reuses() {
        let mut reg = BrowserRegistry::new();
        let a = reg.allocate_id();
        let b = reg.allocate_id();
        assert_ne!(a, b);
        // 关掉再开也不复用序号（避免"旧 id 撞上已销毁视图"的歧义）。
        reg.insert(BrowserView::new(a.clone(), bounds()));
        reg.remove(&a);
        let c = reg.allocate_id();
        assert_ne!(c, a);
        assert_ne!(c, b);
    }
}
