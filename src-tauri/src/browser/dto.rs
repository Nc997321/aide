//! 跨 IPC 边界 DTO：扁平、可序列化。进边界 `TryFrom` 校验重建不变量，出边界 `From` 拍平（M3）。
//! DTO 上不承载业务规矩、不写业务方法——规矩在领域类型（port::types）里。

use serde::{Deserialize, Serialize};

use crate::browser::port::types::{Bounds, BrowserView, NavState, Position, Size, SizeError};

// ── 几何：进/出边界 ────────────────────────────────────────────────────────

/// 矩形 DTO（命名字段——调用点不存在裸位置传参，规避 S2）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct BoundsDto {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// 进边界：DTO → 领域 `Bounds`，经 `Size::try_new` 重建「非负非 NaN」不变量。
impl TryFrom<BoundsDto> for Bounds {
    type Error = SizeError;

    fn try_from(d: BoundsDto) -> Result<Self, Self::Error> {
        let size = Size::try_new(d.w, d.h)?;
        Ok(Bounds::new(Position::new(d.x, d.y), size))
    }
}

/// 出边界：领域 `Bounds` → DTO 拍平。
impl From<Bounds> for BoundsDto {
    fn from(b: Bounds) -> Self {
        let (pos, size) = (b.position(), b.size());
        Self {
            x: pos.x(),
            y: pos.y(),
            w: size.w(),
            h: size.h(),
        }
    }
}

// ── 导航状态：出边界 ───────────────────────────────────────────────────────

/// `NavState` 的序列化形态。`tag = "state"` 让前端按 `state` 字段判别。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum NavStateDto {
    Idle,
    Loading { url: String },
    Ready { url: String, title: String },
    Failed { url: String, reason: String },
}

impl From<&NavState> for NavStateDto {
    fn from(s: &NavState) -> Self {
        match s {
            NavState::Idle => NavStateDto::Idle,
            NavState::Loading { url } => NavStateDto::Loading {
                url: url.to_string(),
            },
            NavState::Ready { url, title } => NavStateDto::Ready {
                url: url.to_string(),
                title: title.clone(),
            },
            NavState::Failed { url, reason } => NavStateDto::Failed {
                url: url.to_string(),
                reason: reason.clone(),
            },
        }
    }
}

// ── 视图快照 / 事件：出边界 ────────────────────────────────────────────────

/// 视图完整快照（创建后、状态变更时回灌前端）。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BrowserViewDto {
    pub id: String,
    pub nav: NavStateDto,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub bounds: BoundsDto,
    pub visible: bool,
}

impl From<&BrowserView> for BrowserViewDto {
    fn from(v: &BrowserView) -> Self {
        Self {
            id: v.id().as_str().to_string(),
            nav: NavStateDto::from(v.nav()),
            can_go_back: v.can_go_back(),
            can_go_forward: v.can_go_forward(),
            bounds: BoundsDto::from(v.bounds()),
            visible: v.visible(),
        }
    }
}

/// 导航事件（经事件通道广播；前端 UI 状态只认事件，不做乐观更新——CLAUDE.md 多端一致性红线）。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NavEventDto {
    pub id: String,
    #[serde(flatten)]
    pub nav: NavStateDto,
}

// ── 创建请求：进边界 ───────────────────────────────────────────────────────

/// 创建浏览器视图的入参（窗口句柄由命令层用 `app.get_window("main")` 取得，不在 DTO 内）。
#[derive(Debug, Clone, Deserialize)]
pub struct CreateBrowserDto {
    /// 视图标识（前端生成，如 `browser-<ts>`）；newtype 守门非空在命令层做。
    pub id: String,
    pub url: String,
    pub bounds: BoundsDto,
}
