//! DTO 边界转换单测：进边界 TryFrom 重建不变量、出边界 From 拍平（M3）。

use crate::browser::dto::{BoundsDto, BrowserViewDto, NavStateDto};
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
