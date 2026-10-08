//! `BrowserView` 集合的唯一主人 + Tauri 托管状态包装。
//!
//! **视图属于创建它的窗口**（一个窗口 = 一个 Host，各自的浏览器面板互不可见）：注册表进程级
//! 一份（id 全局唯一、引擎按 id 寻址），但每条视图记着属主窗口标签，门面的读写一律经
//! `*_in(窗口)` 变体——别的窗口拿着别人的 id 也等于「不存在」。
//!
//! 注册成 `Arc<Mutex<..>>`（项目记忆：`State<'_, T>` 引用参数不能跨 `spawn_blocking`，state 注册
//! `Arc<T>` 后 clone 进闭包）。锁选 `std::sync::Mutex`：注册表只持纯领域状态、加锁期内不 await、
//! 引擎 IO 在锁外执行——std 锁足够且避免 async 锁开销（线程模型最终态在 adapter 阶段定）。

use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::browser::port::types::{BrowserView, BrowserViewId};

/// 所有活动浏览器视图的注册表。`BrowserView` 的唯一主人——增删查改只经此（M1）。
#[derive(Debug, Default)]
pub struct BrowserRegistry {
    views: HashMap<BrowserViewId, BrowserView>,
    /// 视图 → 属主窗口标签。与 `views` 同进同出（只经 `insert` / `remove` 改），不会失配。
    owners: HashMap<BrowserViewId, String>,
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

    /// 入库并记属主窗口；若同 id 已存在，返回被替换的旧视图（调用方据此决定是否先 close 引擎侧）。
    pub fn insert(&mut self, view: BrowserView, window: &str) -> Option<BrowserView> {
        self.owners.insert(view.id().clone(), window.to_string());
        self.views.insert(view.id().clone(), view)
    }

    /// 视图的属主窗口。加载信号（按 id 到达、不带窗口）靠它把导航事件投给对的窗口。
    pub fn owner_of(&self, id: &BrowserViewId) -> Option<&str> {
        self.owners.get(id).map(String::as_str)
    }

    /// 只认属主窗口的读：别的窗口拿着这个 id 等于视图不存在。
    pub fn get_in(&self, id: &BrowserViewId, window: &str) -> Option<&BrowserView> {
        if self.owner_of(id)? == window {
            self.views.get(id)
        } else {
            None
        }
    }

    /// 只认属主窗口的写（同 [`get_in`](Self::get_in)）。
    pub fn get_mut_in(&mut self, id: &BrowserViewId, window: &str) -> Option<&mut BrowserView> {
        if self.owner_of(id)? == window {
            self.views.get_mut(id)
        } else {
            None
        }
    }

    /// 不分窗口的写：只给按 id 到达的内部信号（页面加载）用——它们不带窗口、也不该被窗口挡住。
    pub fn get_mut(&mut self, id: &BrowserViewId) -> Option<&mut BrowserView> {
        self.views.get_mut(id)
    }

    pub fn get(&self, id: &BrowserViewId) -> Option<&BrowserView> {
        self.views.get(id)
    }

    pub fn remove(&mut self, id: &BrowserViewId) -> Option<BrowserView> {
        self.owners.remove(id);
        self.views.remove(id)
    }

    /// 某窗口名下的全部视图 id（窗口销毁时据此回收）。
    pub fn ids_of_window(&self, window: &str) -> Vec<BrowserViewId> {
        self.owners
            .iter()
            .filter(|(_, w)| w.as_str() == window)
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// 某窗口名下的视图，**按 id 序号升序**。
    ///
    /// 存在理由：`HashMap` 迭代顺序不定——同一份状态两次调用可能给出不同顺序，调用方
    /// （`browser_tabs` 列表、agent 选 view_id、UI 对账）按位置取视图会莫名错位。
    /// 排序用**数字序**而非字典序：字典序下 `browser-10` 会排到 `browser-2` 前面。
    pub fn views_in_order_of(&self, window: &str) -> Vec<&BrowserView> {
        let mut views: Vec<&BrowserView> = self
            .views
            .values()
            .filter(|v| self.owner_of(v.id()) == Some(window))
            .collect();
        views.sort_by(|a, b| cmp_views(a, b));
        views
    }
}

/// 视图排序：双方都是本注册表生成的 id（`browser-<n>`）时按 n 升序；解析不出序号的一方垫底，
/// 都解析不出则按字典序。构成全序（无环），`sort_by` 可安全使用。
fn cmp_views(a: &BrowserView, b: &BrowserView) -> Ordering {
    match (seq_of(a.id()), seq_of(b.id())) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => a.id().as_str().cmp(b.id().as_str()),
    }
}

/// 从 `browser-<n>` 取 n。`allocate_id` 是唯一生成方，故正常情况下恒 `Some`；
/// 解析不出时由调用方兜底排序（宁可顺序怪，不可 panic）。
fn seq_of(id: &BrowserViewId) -> Option<u64> {
    id.as_str()
        .strip_prefix("browser-")
        .and_then(|n| n.parse::<u64>().ok())
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

    /// 直接造 id（不经 `allocate_id`），使 Map 的插入序与目标序**相反**——这样「根本没排序、
    /// 只是恰好按插入序迭代」的坏实现不会假绿；同时跨越 9→10 进位点，字典序实现必翻车。
    #[test]
    fn views_in_order_sorts_numerically_not_lexically() {
        let mut reg = BrowserRegistry::new();
        for raw in [
            "browser-11",
            "browser-10",
            "browser-9",
            "browser-3",
            "browser-2",
            "browser-1",
        ] {
            let id = BrowserViewId::try_new(raw).unwrap();
            reg.insert(BrowserView::new(id, bounds()), "main");
        }

        let got: Vec<&str> = reg
            .views_in_order_of("main")
            .iter()
            .map(|v| v.id().as_str())
            .collect();
        assert_eq!(
            got,
            [
                "browser-1",
                "browser-2",
                "browser-3",
                "browser-9",
                "browser-10",
                "browser-11"
            ]
        );
    }

    /// 解析不出序号的一方垫底（不该 panic，也不该排到正经 id 前面）。
    #[test]
    fn views_in_order_puts_unparseable_ids_last() {
        let mut reg = BrowserRegistry::new();
        for raw in ["browser-2", "weird-id", "browser-1", "another"] {
            let id = BrowserViewId::try_new(raw).unwrap();
            reg.insert(BrowserView::new(id, bounds()), "main");
        }

        let got: Vec<&str> = reg
            .views_in_order_of("main")
            .iter()
            .map(|v| v.id().as_str())
            .collect();
        // 有序号的在前（数字序），无序号的两条垫底且彼此字典序。
        assert_eq!(got, ["browser-1", "browser-2", "another", "weird-id"]);
    }

    #[test]
    fn allocate_id_is_unique_and_never_reuses() {
        let mut reg = BrowserRegistry::new();
        let a = reg.allocate_id();
        let b = reg.allocate_id();
        assert_ne!(a, b);
        // 关掉再开也不复用序号（避免"旧 id 撞上已销毁视图"的歧义）。
        reg.insert(BrowserView::new(a.clone(), bounds()), "main");
        reg.remove(&a);
        let c = reg.allocate_id();
        assert_ne!(c, a);
        assert_ne!(c, b);
    }

    fn view(raw: &str) -> BrowserView {
        BrowserView::new(BrowserViewId::try_new(raw).unwrap(), bounds())
    }

    /// 视图属于创建它的窗口：别的窗口读不到、写不到、列不出——拿着别人的 id 也等于不存在。
    #[test]
    fn views_are_invisible_to_other_windows() {
        let mut reg = BrowserRegistry::new();
        reg.insert(view("browser-1"), "main");
        reg.insert(view("browser-2"), "host-wsl_Debian");
        let one = BrowserViewId::try_new("browser-1").unwrap();
        let two = BrowserViewId::try_new("browser-2").unwrap();

        assert!(reg.get_in(&one, "main").is_some());
        assert!(reg.get_in(&one, "host-wsl_Debian").is_none());
        assert!(reg.get_mut_in(&two, "main").is_none());
        assert!(reg.get_mut_in(&two, "host-wsl_Debian").is_some());

        let ids = |w: &str| -> Vec<String> {
            reg.views_in_order_of(w).iter().map(|v| v.id().as_str().to_string()).collect()
        };
        assert_eq!(ids("main"), ["browser-1"]);
        assert_eq!(ids("host-wsl_Debian"), ["browser-2"]);
        assert!(ids("nobody").is_empty());

        // 不分窗口的内部读写（加载信号按 id 到达）仍然够得着，并能反查属主。
        assert!(reg.get(&two).is_some());
        assert_eq!(reg.owner_of(&two), Some("host-wsl_Debian"));
    }

    /// 窗口销毁时按属主回收；移除视图同时抹掉属主记录（不留孤儿）。
    #[test]
    fn ids_of_window_and_remove_keep_owners_in_step() {
        let mut reg = BrowserRegistry::new();
        reg.insert(view("browser-1"), "main");
        reg.insert(view("browser-2"), "host-a");
        reg.insert(view("browser-3"), "host-a");

        let mut ids: Vec<String> = reg
            .ids_of_window("host-a")
            .iter()
            .map(|i| i.as_str().to_string())
            .collect();
        ids.sort();
        assert_eq!(ids, ["browser-2", "browser-3"]);

        let two = BrowserViewId::try_new("browser-2").unwrap();
        assert!(reg.remove(&two).is_some());
        assert_eq!(reg.owner_of(&two), None);
        assert_eq!(reg.ids_of_window("host-a").len(), 1);
    }
}
