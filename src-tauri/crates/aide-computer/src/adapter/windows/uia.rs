//! UI Automation：一次跨进程调用取回整棵控件树（CacheRequest + Subtree），再在本地遍历。

use std::collections::HashMap;
use std::mem::ManuallyDrop;

use windows::core::BSTR;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER, SAFEARRAY};
use windows::Win32::System::Ole::{SafeArrayDestroy, SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound};
use windows::Win32::System::Variant::{VariantClear, VARIANT, VT_ARRAY, VT_BOOL, VT_BSTR, VT_I4};
use windows::Win32::UI::Accessibility::*;

use crate::model::{Patterns, PatternClick, RawElement, Rect};
use crate::prune::innermost;
use crate::port::Res;

/// 原始树最多遍历多少个元素（超出截断）。
const MAX_RAW: usize = 5000;
const MAX_DEPTH: u16 = 64;
/// 文字控件最多取多少字（再由裁剪层保留末尾）。
const MAX_DOC_CHARS: i32 = 200_000;

pub struct Uia {
    auto: IUIAutomation,
    req: IUIAutomationCacheRequest,
    /// 每个窗口最近一次读取里的元素（按 RuntimeId），动作时据此找回元素。
    cache: HashMap<String, HashMap<Vec<i32>, IUIAutomationElement>>,
}

const PROPS: &[UIA_PROPERTY_ID] = &[
    UIA_RuntimeIdPropertyId,
    UIA_NamePropertyId,
    UIA_ControlTypePropertyId,
    UIA_BoundingRectanglePropertyId,
    UIA_IsEnabledPropertyId,
    UIA_HasKeyboardFocusPropertyId,
    UIA_IsKeyboardFocusablePropertyId,
    UIA_IsPasswordPropertyId,
    UIA_IsOffscreenPropertyId,
    UIA_ValueValuePropertyId,
    UIA_ValueIsReadOnlyPropertyId,
    UIA_IsValuePatternAvailablePropertyId,
    UIA_IsInvokePatternAvailablePropertyId,
    UIA_IsTogglePatternAvailablePropertyId,
    UIA_ToggleToggleStatePropertyId,
    UIA_IsSelectionItemPatternAvailablePropertyId,
    UIA_SelectionItemIsSelectedPropertyId,
    UIA_IsExpandCollapsePatternAvailablePropertyId,
    UIA_ExpandCollapseExpandCollapseStatePropertyId,
    UIA_IsTextPatternAvailablePropertyId,
];

impl Uia {
    /// 调用方须已在本线程 `CoInitializeEx(MTA)`。
    pub fn new() -> Res<Self> {
        unsafe {
            let auto: IUIAutomation = CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)
                .or_else(|_| CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER))
                .map_err(|e| format!("UI Automation is not available: {e}"))?;
            let req = auto.CreateCacheRequest().map_err(|e| e.to_string())?;
            for p in PROPS {
                req.AddProperty(*p).map_err(|e| e.to_string())?;
            }
            req.SetTreeScope(TreeScope_Subtree).map_err(|e| e.to_string())?;
            req.SetTreeFilter(&auto.ControlViewCondition().map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            // Full：缓存之外仍保留活引用，动作时能直接调模式。
            req.SetAutomationElementMode(AutomationElementMode_Full).map_err(|e| e.to_string())?;
            Ok(Self { auto, req, cache: HashMap::new() })
        }
    }

    pub fn snapshot(&mut self, window: &str, hwnd: HWND, text_tail: Option<u32>) -> Res<(Vec<RawElement>, bool)> {
        let root = unsafe {
            self.auto
                .ElementFromHandle(hwnd)
                .and_then(|e| e.BuildUpdatedCache(&self.req))
                .map_err(|e| format!("Could not read this window's controls: {e}"))?
        };
        let mut out = Vec::new();
        let mut live: Vec<IUIAutomationElement> = Vec::new();
        let mut map = HashMap::new();
        let mut truncated = false;
        let mut stack: Vec<(IUIAutomationElement, u16)> = vec![(root, 0)];
        while let Some((el, depth)) = stack.pop() {
            if out.len() >= MAX_RAW {
                truncated = true;
                break;
            }
            let raw = unsafe { read_cached(&el, depth) };
            if !raw.runtime_id.is_empty() {
                map.insert(raw.runtime_id.clone(), el.clone());
            }
            out.push(raw);
            live.push(el.clone());
            if depth >= MAX_DEPTH {
                continue;
            }
            if let Ok(children) = unsafe { el.GetCachedChildren() } {
                let n = unsafe { children.Length() }.unwrap_or(0);
                // 倒序入栈 → 先序出栈
                for i in (0..n).rev() {
                    if let Ok(c) = unsafe { children.GetElement(i) } {
                        stack.push((c, depth + 1));
                    }
                }
            }
        }
        // 文字只从「最里层」的文字控件取：子孙里还有文字控件的（网页正文、分组）跳过，
        // 否则同一段文字会在每一层祖先上重复一遍。终端、文档本身就是最里层。
        let has_text: Vec<bool> = out.iter().map(|e| e.patterns.text && !e.bounds.is_empty()).collect();
        let depths: Vec<u16> = out.iter().map(|e| e.depth).collect();
        let inner = innermost(&depths, &has_text);
        for (i, e) in out.iter_mut().enumerate() {
            if inner[i] && (e.value.is_none() || e.role == "Document") {
                e.text = unsafe { read_text(&live[i], text_tail) }.filter(|t| t.trim() != e.name.trim());
            }
        }
        self.cache.insert(window.to_string(), map);
        Ok((out, truncated))
    }

    fn element(&self, window: &str, rid: &[i32]) -> Res<&IUIAutomationElement> {
        self.cache
            .get(window)
            .and_then(|m| m.get(rid))
            .ok_or_else(|| "That element is not in the latest read of this window. Call computer_read again.".into())
    }

    pub fn alive(&self, window: &str, rid: &[i32], role: &str) -> Res<bool> {
        let Ok(el) = self.element(window, rid) else { return Ok(false) };
        Ok(match unsafe { el.CurrentControlType() } {
            Ok(t) => role_name(t) == role,
            Err(_) => false,
        })
    }

    pub fn pattern_click(&self, window: &str, rid: &[i32]) -> Res<PatternClick> {
        let el = self.element(window, rid)?;
        unsafe {
            if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
                p.Invoke().map_err(|e| format!("Invoke failed: {e}"))?;
                return Ok(PatternClick::Done("invoked"));
            }
            if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) {
                p.Toggle().map_err(|e| format!("Toggle failed: {e}"))?;
                return Ok(PatternClick::Done("toggled"));
            }
            if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) {
                p.Select().map_err(|e| format!("Select failed: {e}"))?;
                return Ok(PatternClick::Done("selected"));
            }
            if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId) {
                let state = p.CurrentExpandCollapseState().unwrap_or(ExpandCollapseState_Collapsed);
                if state == ExpandCollapseState_Expanded {
                    p.Collapse().map_err(|e| format!("Collapse failed: {e}"))?;
                    return Ok(PatternClick::Done("collapsed"));
                }
                p.Expand().map_err(|e| format!("Expand failed: {e}"))?;
                return Ok(PatternClick::Done("expanded"));
            }
        }
        Ok(PatternClick::Unsupported)
    }

    pub fn center(&self, window: &str, rid: &[i32]) -> Res<(i32, i32)> {
        let el = self.element(window, rid)?;
        let r = unsafe { el.CurrentBoundingRectangle() }.map_err(|_| "The element is gone. Call computer_read again.".to_string())?;
        let rect = Rect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top };
        if rect.is_empty() {
            return Err("The element is not visible on screen (scroll it into view first).".into());
        }
        Ok(rect.center())
    }

    pub fn focus(&self, window: &str, rid: &[i32]) -> Res<()> {
        let el = self.element(window, rid)?;
        unsafe { el.SetFocus() }.map_err(|e| format!("Could not focus the element: {e}"))
    }

    pub fn set_value(&self, window: &str, rid: &[i32], value: &str) -> Res<()> {
        let el = self.element(window, rid)?;
        unsafe {
            let p = el
                .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                .map_err(|_| "This element does not accept a value; click it and use type instead.".to_string())?;
            p.SetValue(&BSTR::from(value)).map_err(|e| format!("Setting the value failed: {e}"))
        }
    }

    /// 前台窗口里的焦点元素。
    pub fn focused(&self) -> Option<(Vec<i32>, String)> {
        unsafe {
            let el = self.auto.GetFocusedElement().ok()?;
            let rid = runtime_id_live(&el);
            let name = el.CurrentName().map(|b| b.to_string()).unwrap_or_default();
            Some((rid, name))
        }
    }
}

unsafe fn runtime_id_live(el: &IUIAutomationElement) -> Vec<i32> {
    match el.GetRuntimeId() {
        Ok(sa) if !sa.is_null() => {
            let v = safearray_i32(sa);
            let _ = SafeArrayDestroy(sa);
            v
        }
        _ => Vec::new(),
    }
}

unsafe fn read_cached(el: &IUIAutomationElement, depth: u16) -> RawElement {
    let role = el.CachedControlType().map(role_name).unwrap_or("Unknown").to_string();
    let r = el.CachedBoundingRectangle().unwrap_or_default();
    let offscreen = el.CachedIsOffscreen().map(|b| b.as_bool()).unwrap_or(false);
    let bounds = if offscreen {
        Rect::default()
    } else {
        Rect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top }
    };
    let value_available = cached_bool(el, UIA_IsValuePatternAvailablePropertyId);
    let text_available = cached_bool(el, UIA_IsTextPatternAvailablePropertyId);
    let toggle = cached_bool(el, UIA_IsTogglePatternAvailablePropertyId);
    let expand = cached_bool(el, UIA_IsExpandCollapsePatternAvailablePropertyId);
    let select = cached_bool(el, UIA_IsSelectionItemPatternAvailablePropertyId);
    let value = if value_available { cached_string(el, UIA_ValueValuePropertyId).filter(|v| !v.is_empty()) } else { None };
    let patterns = Patterns {
        invoke: cached_bool(el, UIA_IsInvokePatternAvailablePropertyId),
        toggle,
        // ToggleState: 0 off, 1 on, 2 indeterminate
        toggled: if toggle { cached_i32(el, UIA_ToggleToggleStatePropertyId).and_then(|s| match s { 0 => Some(false), 1 => Some(true), _ => None }) } else { None },
        select,
        selected: select && cached_bool(el, UIA_SelectionItemIsSelectedPropertyId),
        expand,
        // ExpandCollapseState: 0 collapsed, 1 expanded, 2 partial, 3 leaf
        expanded: if expand { cached_i32(el, UIA_ExpandCollapseExpandCollapseStatePropertyId).and_then(|s| match s { 0 => Some(false), 1 | 2 => Some(true), _ => None }) } else { None },
        value_editable: value_available && !cached_bool(el, UIA_ValueIsReadOnlyPropertyId),
        text: text_available,
    };
    RawElement {
        runtime_id: cached_runtime_id(el),
        role,
        name: el.CachedName().map(|b| b.to_string()).unwrap_or_default(),
        value,
        text: None,
        depth,
        bounds,
        enabled: el.CachedIsEnabled().map(|b| b.as_bool()).unwrap_or(true),
        focused: el.CachedHasKeyboardFocus().map(|b| b.as_bool()).unwrap_or(false),
        focusable: el.CachedIsKeyboardFocusable().map(|b| b.as_bool()).unwrap_or(false),
        password: el.CachedIsPassword().map(|b| b.as_bool()).unwrap_or(false),
        patterns,
    }
}

/// 文字：默认取可见部分；`text_tail` = 取全文末尾若干行（终端回滚区）。
unsafe fn read_text(el: &IUIAutomationElement, text_tail: Option<u32>) -> Option<String> {
    let tp = el.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId).ok()?;
    let text = match text_tail {
        Some(n) => {
            let all = tp.DocumentRange().ok()?.GetText(MAX_DOC_CHARS).ok()?.to_string();
            tail_lines(&all, n as usize)
        }
        None => {
            let ranges = tp.GetVisibleRanges().ok()?;
            let n = ranges.Length().unwrap_or(0);
            let mut parts = Vec::new();
            for i in 0..n {
                if let Ok(r) = ranges.GetElement(i) {
                    if let Ok(t) = r.GetText(MAX_DOC_CHARS) {
                        parts.push(t.to_string());
                    }
                }
            }
            parts.join("\n")
        }
    };
    let cleaned = clean_text(&text);
    (!cleaned.is_empty()).then_some(cleaned)
}

/// 去掉每行行尾空白与末尾空行（终端缓冲区下面全是空行）。
fn clean_text(s: &str) -> String {
    let lines: Vec<&str> = s.split(['\n']).map(|l| l.trim_end_matches(['\r', ' ', '\t'])).collect();
    let end = lines.iter().rposition(|l| !l.is_empty()).map_or(0, |i| i + 1);
    lines[..end].join("\n")
}

fn tail_lines(s: &str, n: usize) -> String {
    let cleaned = clean_text(s);
    let lines: Vec<&str> = cleaned.lines().collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

// ------------------------------------------------------------ VARIANT / SAFEARRAY

unsafe fn with_variant<T>(el: &IUIAutomationElement, prop: UIA_PROPERTY_ID, f: impl FnOnce(&VARIANT) -> Option<T>) -> Option<T> {
    let mut v = el.GetCachedPropertyValue(prop).ok()?;
    let out = f(&v);
    let _ = VariantClear(&mut v);
    out
}

unsafe fn cached_bool(el: &IUIAutomationElement, prop: UIA_PROPERTY_ID) -> bool {
    with_variant(el, prop, |v| {
        let inner = &v.Anonymous.Anonymous;
        (inner.vt == VT_BOOL).then(|| inner.Anonymous.boolVal.as_bool())
    })
    .unwrap_or(false)
}

unsafe fn cached_i32(el: &IUIAutomationElement, prop: UIA_PROPERTY_ID) -> Option<i32> {
    with_variant(el, prop, |v| {
        let inner = &v.Anonymous.Anonymous;
        (inner.vt == VT_I4).then(|| inner.Anonymous.lVal)
    })
}

unsafe fn cached_string(el: &IUIAutomationElement, prop: UIA_PROPERTY_ID) -> Option<String> {
    with_variant(el, prop, |v| {
        let inner = &v.Anonymous.Anonymous;
        (inner.vt == VT_BSTR).then(|| {
            let b: &ManuallyDrop<BSTR> = &inner.Anonymous.bstrVal;
            b.to_string()
        })
    })
}

unsafe fn cached_runtime_id(el: &IUIAutomationElement) -> Vec<i32> {
    with_variant(el, UIA_RuntimeIdPropertyId, |v| {
        let inner = &v.Anonymous.Anonymous;
        (inner.vt.0 & VT_ARRAY.0 != 0 && !inner.Anonymous.parray.is_null()).then(|| safearray_i32(inner.Anonymous.parray))
    })
    .unwrap_or_default()
}

unsafe fn safearray_i32(sa: *const SAFEARRAY) -> Vec<i32> {
    let (Ok(lo), Ok(hi)) = (SafeArrayGetLBound(sa, 1), SafeArrayGetUBound(sa, 1)) else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity((hi - lo + 1).max(0) as usize);
    for i in lo..=hi {
        let mut x: i32 = 0;
        if SafeArrayGetElement(sa, &i, &mut x as *mut i32 as *mut _).is_ok() {
            out.push(x);
        }
    }
    out
}

pub fn role_name(t: UIA_CONTROLTYPE_ID) -> &'static str {
    match t.0 {
        50000 => "Button",
        50001 => "Calendar",
        50002 => "CheckBox",
        50003 => "ComboBox",
        50004 => "Edit",
        50005 => "Hyperlink",
        50006 => "Image",
        50007 => "ListItem",
        50008 => "List",
        50009 => "Menu",
        50010 => "MenuBar",
        50011 => "MenuItem",
        50012 => "ProgressBar",
        50013 => "RadioButton",
        50014 => "ScrollBar",
        50015 => "Slider",
        50016 => "Spinner",
        50017 => "StatusBar",
        50018 => "Tab",
        50019 => "TabItem",
        50020 => "Text",
        50021 => "ToolBar",
        50022 => "ToolTip",
        50023 => "Tree",
        50024 => "TreeItem",
        50025 => "Custom",
        50026 => "Group",
        50027 => "Thumb",
        50028 => "DataGrid",
        50029 => "DataItem",
        50030 => "Document",
        50031 => "SplitButton",
        50032 => "Window",
        50033 => "Pane",
        50034 => "Header",
        50035 => "HeaderItem",
        50036 => "Table",
        50037 => "TitleBar",
        50038 => "Separator",
        50039 => "SemanticZoom",
        50040 => "AppBar",
        _ => "Unknown",
    }
}
