//! 领域类型单测：BrowserViewId / Size / Bounds 守门 + BrowserView 导航状态机。
//! 重点验「非法状态造不出来 / 非法跳转被守门拒绝」（M5/M6），覆盖带值路径 + 非法路径。

use url::Url;

use crate::browser::port::types::{
    Bounds, BrowserView, BrowserViewId, BrowserViewIdError, NavState, Position, Size, SizeError,
    ViewError,
};

fn url(s: &str) -> Url {
    Url::parse(s).unwrap()
}

fn view() -> BrowserView {
    BrowserView::new(
        BrowserViewId::try_new("v1").unwrap(),
        Bounds::new(Position::new(0.0, 0.0), Size::try_new(100.0, 50.0).unwrap()),
    )
}

// ── BrowserViewId：非空 newtype ──

#[test]
fn id_rejects_empty_and_whitespace() {
    assert_eq!(BrowserViewId::try_new(""), Err(BrowserViewIdError::Empty));
    assert_eq!(
        BrowserViewId::try_new("   "),
        Err(BrowserViewIdError::Empty)
    );
}

#[test]
fn id_accepts_nonempty_and_exposes_str() {
    let id = BrowserViewId::try_new("browser-main").unwrap();
    assert_eq!(id.as_str(), "browser-main");
}

// ── Size：非负非 NaN 守门 ──

#[test]
fn size_rejects_negative() {
    assert!(matches!(
        Size::try_new(-1.0, 10.0),
        Err(SizeError::Negative { .. })
    ));
    assert!(matches!(
        Size::try_new(10.0, -0.5),
        Err(SizeError::Negative { .. })
    ));
}

#[test]
fn size_rejects_nan() {
    assert!(matches!(
        Size::try_new(f64::NAN, 10.0),
        Err(SizeError::NotFinite { .. })
    ));
}

#[test]
fn size_accepts_zero_and_positive() {
    assert_eq!(Size::try_new(0.0, 0.0).unwrap(), Size::ZERO);
    assert_eq!(Size::try_new(1.0, 2.0).unwrap().w(), 1.0);
}

// ── Bounds：隐藏态 ──

#[test]
fn bounds_hidden_is_offscreen_zero_size() {
    let h = Bounds::hidden();
    assert_eq!(h.size(), Size::ZERO);
    assert!(h.position().x() < 0.0 && h.position().y() < 0.0);
}

// ── BrowserView：新视图初始态 ──

#[test]
fn new_view_is_idle_visible_no_history() {
    let v = view();
    assert_eq!(*v.nav(), NavState::Idle);
    assert_eq!(v.current_url(), None);
    assert!(v.visible());
    assert!(!v.can_go_back());
    assert!(!v.can_go_forward());
}

// ── 导航：begin → finish/fail ──

#[test]
fn begin_nav_sets_loading_and_records_url() {
    let mut v = view();
    v.begin_nav(url("https://a.com"));
    assert_eq!(
        *v.nav(),
        NavState::Loading {
            url: url("https://a.com")
        }
    );
    assert_eq!(v.current_url(), Some(&url("https://a.com")));
}

#[test]
fn finish_nav_from_loading_sets_ready_with_title() {
    let mut v = view();
    v.begin_nav(url("https://a.com"));
    v.finish_nav("A".into()).unwrap();
    assert_eq!(
        *v.nav(),
        NavState::Ready {
            url: url("https://a.com"),
            title: "A".into()
        }
    );
}

#[test]
fn fail_nav_from_loading_sets_failed_with_reason() {
    let mut v = view();
    v.begin_nav(url("https://a.com"));
    v.fail_nav("net::ERR".into()).unwrap();
    assert_eq!(
        *v.nav(),
        NavState::Failed {
            url: url("https://a.com"),
            reason: "net::ERR".into()
        }
    );
}

#[test]
fn finish_nav_from_idle_is_rejected() {
    // 非法跳转：Idle 态没有正在加载的 url，finish_nav 必被守门拒绝（M6）。
    let mut v = view();
    assert_eq!(v.finish_nav("A".into()), Err(ViewError::NotLoading));
    assert_eq!(*v.nav(), NavState::Idle); // 状态未被破坏
}

#[test]
fn fail_nav_from_ready_is_rejected() {
    let mut v = view();
    v.begin_nav(url("https://a.com"));
    v.finish_nav("A".into()).unwrap();
    assert_eq!(v.fail_nav("late".into()), Err(ViewError::NotLoading));
}

// ── 历史 / 前进后退 ──

#[test]
fn single_nav_has_no_back_no_forward() {
    let mut v = view();
    v.begin_nav(url("https://a.com"));
    assert!(!v.can_go_back());
    assert!(!v.can_go_forward());
}

#[test]
fn back_then_forward_walks_history() {
    let mut v = view();
    v.begin_nav(url("https://a.com"));
    v.begin_nav(url("https://b.com"));
    v.begin_nav(url("https://c.com"));
    assert!(v.can_go_back());
    assert!(!v.can_go_forward());

    // 后退到 b：返回目标 url 给外壳加载，状态置 Loading。
    assert_eq!(v.go_back(), Some(url("https://b.com")));
    assert_eq!(
        *v.nav(),
        NavState::Loading {
            url: url("https://b.com")
        }
    );
    assert!(v.can_go_back() && v.can_go_forward());

    assert_eq!(v.go_back(), Some(url("https://a.com")));
    assert!(!v.can_go_back());

    assert_eq!(v.go_forward(), Some(url("https://b.com")));
    assert_eq!(v.go_forward(), Some(url("https://c.com")));
    assert!(!v.can_go_forward());
}

#[test]
fn go_back_at_front_is_none_and_stateless() {
    let mut v = view();
    v.begin_nav(url("https://a.com"));
    let nav_before = v.nav().clone();
    assert_eq!(v.go_back(), None);
    assert_eq!(*v.nav(), nav_before); // 无可退时不改任何状态
}

#[test]
fn go_forward_at_end_is_none_and_stateless() {
    // 与 go_back 的 None 路径对称：已在末尾时前进返回 None 且不改状态。
    let mut v = view();
    v.begin_nav(url("https://a.com"));
    let nav_before = v.nav().clone();
    assert_eq!(v.go_forward(), None);
    assert_eq!(*v.nav(), nav_before);
}

#[test]
fn begin_nav_after_back_truncates_forward_branch() {
    let mut v = view();
    v.begin_nav(url("https://a.com"));
    v.begin_nav(url("https://b.com"));
    v.begin_nav(url("https://c.com"));
    v.go_back(); // 现在在 b，c 是前进分支
    v.go_back(); // 现在在 a

    // 从 a 去 d：b、c 整条前进分支被截断，历史变 a→d。
    v.begin_nav(url("https://d.com"));
    assert!(!v.can_go_forward());
    assert_eq!(v.go_back(), Some(url("https://a.com")));
    assert!(!v.can_go_back());
}

// ── 布局 / 可见性 ──

#[test]
fn set_bounds_and_visible_take_effect() {
    let mut v = view();
    let b = Bounds::new(
        Position::new(10.0, 20.0),
        Size::try_new(300.0, 200.0).unwrap(),
    );
    v.set_bounds(b);
    v.set_visible(false);
    assert_eq!(v.bounds(), b);
    assert!(!v.visible());
}
