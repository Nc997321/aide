//! DTO 边界转换单测：进边界 TryFrom 重建不变量、出边界 From 拍平（M3）。

use crate::browser::bookmarks::ImportReport;
use crate::browser::dto::{
    BookmarkDto, BoundsDto, BrowserViewDto, CreateBrowserDto, ImportReportDto, NavEventDto,
    NavStateDto,
};
use crate::browser::port::types::{Bounds, BrowserView, BrowserViewId, NavState, Position, Size};

// ── BoundsDto ↔ Bounds ──

#[test]
fn bounds_dto_to_domain_validates_size() {
    let b: Bounds = BoundsDto {
        x: 1.0,
        y: 2.0,
        w: 300.0,
        h: 200.0,
    }
    .try_into()
    .expect("正尺寸应重建成功");
    assert_eq!(b.position(), Position::new(1.0, 2.0));
    assert_eq!(b.size(), Size::try_new(300.0, 200.0).unwrap());
}

#[test]
fn bounds_dto_rejects_negative_size() {
    // 进边界守门：负尺寸被 Size::try_new 拒，非法值进不了领域层。
    let r: Result<Bounds, _> = BoundsDto {
        x: 0.0,
        y: 0.0,
        w: -5.0,
        h: 10.0,
    }
    .try_into();
    assert!(r.is_err());
}

#[test]
fn bounds_roundtrips_through_dto() {
    let original = Bounds::new(Position::new(8.0, 9.0), Size::try_new(64.0, 32.0).unwrap());
    let dto = BoundsDto::from(original);
    let back: Bounds = dto.try_into().unwrap();
    assert_eq!(back, original);
}

// ── NavState → NavStateDto ──

#[test]
fn nav_state_idle_maps_to_dto() {
    assert_eq!(NavStateDto::from(&NavState::Idle), NavStateDto::Idle);
}

#[test]
fn nav_state_ready_carries_url_and_title() {
    let url = url::Url::parse("https://a.com").unwrap();
    let dto = NavStateDto::from(&NavState::Ready {
        url: url.clone(),
        title: "A".into(),
    });
    assert_eq!(
        dto,
        NavStateDto::Ready {
            url: "https://a.com/".into(),
            title: "A".into()
        }
    );
}

#[test]
fn nav_state_failed_carries_url_and_reason() {
    let url = url::Url::parse("https://a.com").unwrap();
    let dto = NavStateDto::from(&NavState::Failed {
        url,
        reason: "net::ERR".into(),
    });
    assert_eq!(
        dto,
        NavStateDto::Failed {
            url: "https://a.com/".into(),
            reason: "net::ERR".into()
        }
    );
}

// ── NavEventDto：事件通道的线上形状（前端契约） ──

#[test]
fn nav_event_serializes_flat_for_frontend() {
    // 前端 `NavEventDto = { id } & NavStateDto`：事件必须**拍平**（`state`/`url` 与 `id` 同级），
    // 不是 `{ id, nav: {...} }`。这条形状漂移在 TS 侧不报错、只会静默不更新——所以钉在测试里。
    let ev = NavEventDto {
        id: "browser-1".into(),
        nav: NavStateDto::Loading {
            url: "https://a.com/".into(),
        },
        can_go_back: true,
        can_go_forward: false,
    };
    let v = serde_json::to_value(&ev).unwrap();
    assert_eq!(v["id"], "browser-1");
    assert_eq!(v["state"], "loading");
    assert_eq!(v["url"], "https://a.com/");
    assert_eq!(v["can_go_back"], true);
    assert_eq!(v["can_go_forward"], false);
    assert!(v.get("nav").is_none(), "nav 必须拍平，不能嵌一层");
}

// ── CreateBrowserDto：进边界（身份不进 DTO） ──

#[test]
fn create_dto_deserializes_without_id() {
    // 身份归状态主人：调用方不给 id（前端不造时间戳 id，未来的 agent 工具也不必先知道 id）。
    let dto: CreateBrowserDto = serde_json::from_value(serde_json::json!({
        "url": "https://a.com",
        "bounds": { "x": 0.0, "y": 0.0, "w": 100.0, "h": 80.0 }
    }))
    .expect("无 id 的创建入参应可反序列化");
    assert_eq!(dto.url, "https://a.com");
    assert_eq!(dto.bounds.w, 100.0);
}

// ── BrowserView → BrowserViewDto ──

#[test]
fn view_dto_reflects_state_and_capabilities() {
    let mut v = BrowserView::new(
        BrowserViewId::try_new("v1").unwrap(),
        Bounds::new(Position::new(0.0, 0.0), Size::try_new(10.0, 10.0).unwrap()),
    );
    v.begin_nav(url::Url::parse("https://a.com").unwrap());
    v.finish_nav("A".into()).unwrap();
    v.begin_nav(url::Url::parse("https://b.com").unwrap());

    let dto = BrowserViewDto::from(&v);
    assert_eq!(dto.id, "v1");
    assert!(dto.can_go_back);
    assert!(!dto.can_go_forward);
    assert!(dto.visible);
    assert!(matches!(dto.nav, NavStateDto::Loading { .. }));
}

// ── 书签 DTO：线上字段名就是前端的契约 ──

#[test]
fn bookmark_dto_serializes_folders_under_that_name() {
    // 前端按 `folders` 分组。**改这个名字 = 静默失效**：前端收到 undefined → 收藏条悄悄退回扁平，
    // 不报错、不抛异常（2026-09 那次「导入后全扁平」就是这一类无声降级）。所以钉在线上形状上。
    let dto = BookmarkDto {
        id: "bm-1".into(),
        title: "A".into(),
        url: "https://a.com/".into(),
        folders: vec!["工作".into(), "漳蒲".into()],
        added_at: 7,
    };
    let v = serde_json::to_value(&dto).expect("DTO 必须可序列化");
    assert_eq!(v["folders"], serde_json::json!(["工作", "漳蒲"]));
    assert_eq!(v["id"], "bm-1");
    assert_eq!(v["added_at"], 7);
}

#[test]
fn import_report_dto_serializes_adopted_and_icons_under_those_names() {
    // 同理：前端要按 `adopted` 报「补目录 N 条」、按 `icons` 报「图标 N 条」——名字漂了就只剩一句
    // 含糊的导入结果，而「图标进来没有」正是史上那次排查卡住的地方。
    let v = serde_json::to_value(ImportReportDto::from(ImportReport {
        added: 1,
        adopted: 2,
        skipped: 3,
        invalid: 4, icons: 5,
    }))
    .expect("DTO 必须可序列化");
    assert_eq!(v["added"], 1);
    assert_eq!(v["adopted"], 2);
    assert_eq!(v["skipped"], 3);
    assert_eq!(v["invalid"], 4);
    assert_eq!(v["icons"], 5);
}
