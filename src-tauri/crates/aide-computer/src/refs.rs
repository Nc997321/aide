//! 元素引用表（`[eN]` ↔ 平台元素身份）与两次读取之间的变化比对。

use std::collections::HashMap;

use serde::Serialize;

use crate::model::ViewElement;

/// 一个窗口的引用表：同一元素（同一 RuntimeId）多次读取拿到同一个编号，变化比对才有意义。
#[derive(Debug, Default)]
pub struct RefTable {
    next: u32,
    by_runtime: HashMap<Vec<i32>, String>,
}

impl RefTable {
    pub fn assign(&mut self, runtime_id: &[i32]) -> String {
        if !runtime_id.is_empty() {
            if let Some(r) = self.by_runtime.get(runtime_id) {
                return r.clone();
            }
        }
        self.next += 1;
        let r = format!("e{}", self.next);
        if !runtime_id.is_empty() {
            self.by_runtime.insert(runtime_id.to_vec(), r.clone());
        }
        r
    }
}

/// 两次读取之间的变化。
#[derive(Debug, Default, Serialize, PartialEq)]
pub struct Diff {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub added: Vec<ViewElement>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub removed: Vec<Gone>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub changed: Vec<Change>,
    /// 因上限没列出的变化条数。
    #[serde(skip_serializing_if = "is_zero")]
    pub omitted: usize,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Gone {
    #[serde(rename = "ref")]
    pub ref_id: String,
    pub role: String,
    pub name: String,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Change {
    #[serde(rename = "ref")]
    pub ref_id: String,
    pub role: String,
    pub name: String,
    /// 字段 → `[之前, 之后]`；文字控件只回新增的那段（`text_added`）。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<(String, String, String)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_added: Option<String>,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

pub const MAX_DIFF_ITEMS: usize = 60;

impl Diff {
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && self.changed.is_empty() && self.omitted == 0
    }
}

pub fn diff(before: &[ViewElement], after: &[ViewElement]) -> Diff {
    let old: HashMap<&str, &ViewElement> = before.iter().map(|e| (e.ref_id.as_str(), e)).collect();
    let new: HashMap<&str, &ViewElement> = after.iter().map(|e| (e.ref_id.as_str(), e)).collect();
    let mut d = Diff::default();
    let mut count = 0usize;
    let mut room = |d: &mut Diff| {
        count += 1;
        if count > MAX_DIFF_ITEMS {
            d.omitted += 1;
            false
        } else {
            true
        }
    };
    for e in after {
        match old.get(e.ref_id.as_str()) {
            None => {
                if room(&mut d) {
                    d.added.push(e.clone());
                }
            }
            Some(o) => {
                if let Some(c) = change(o, e) {
                    if room(&mut d) {
                        d.changed.push(c);
                    }
                }
            }
        }
    }
    for e in before {
        if !new.contains_key(e.ref_id.as_str()) && room(&mut d) {
            d.removed.push(Gone { ref_id: e.ref_id.clone(), role: e.role.clone(), name: e.name.clone() });
        }
    }
    d
}

fn change(o: &ViewElement, n: &ViewElement) -> Option<Change> {
    let mut fields = Vec::new();
    if o.name != n.name {
        fields.push(("name".into(), o.name.clone(), n.name.clone()));
    }
    if o.value != n.value {
        fields.push((
            "value".into(),
            o.value.clone().unwrap_or_default(),
            n.value.clone().unwrap_or_default(),
        ));
    }
    if o.states != n.states {
        fields.push(("states".into(), o.states.join(","), n.states.join(",")));
    }
    let text_added = match (&o.text, &n.text) {
        (Some(a), Some(b)) if a != b => Some(appended(a, b)),
        (None, Some(b)) => Some(b.clone()),
        _ => None,
    };
    if fields.is_empty() && text_added.is_none() {
        return None;
    }
    Some(Change {
        ref_id: n.ref_id.clone(),
        role: n.role.clone(),
        name: n.name.clone(),
        fields,
        text_added,
    })
}

/// `after` 相对 `before` 新出现的文字。终端 / 聊天记录多是尾部追加，但可见区会滚动，
/// 所以找 `before` 的最长后缀在 `after` 里的位置，取它之后的部分；找不到就回整段。
pub fn appended(before: &str, after: &str) -> String {
    if let Some(rest) = after.strip_prefix(before) {
        return rest.to_string();
    }
    // 可见区滚动：before 的尾部若干行出现在 after 里。
    let lines: Vec<&str> = before.lines().collect();
    for take in (1..=lines.len().min(20)).rev() {
        let tail = lines[lines.len() - take..].join("\n");
        if tail.trim().is_empty() {
            continue;
        }
        if let Some(pos) = after.rfind(&tail) {
            return after[pos + tail.len()..].trim_start_matches('\n').to_string();
        }
    }
    after.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(r: &str, name: &str) -> ViewElement {
        ViewElement {
            ref_id: r.into(),
            role: "Button".into(),
            name: name.into(),
            value: None,
            states: vec![],
            depth: 0,
            text: None,
            runtime_id: vec![],
            click_via: None,
        }
    }

    #[test]
    fn same_element_keeps_its_ref() {
        let mut t = RefTable::default();
        let a = t.assign(&[1, 2]);
        let b = t.assign(&[3]);
        assert_eq!(t.assign(&[1, 2]), a);
        assert_ne!(a, b);
        // 没有身份的元素每次都是新编号
        assert_ne!(t.assign(&[]), t.assign(&[]));
    }

    #[test]
    fn diff_reports_added_removed_changed() {
        let before = vec![v("e1", "保存"), v("e2", "取消")];
        let mut changed = v("e1", "保存");
        changed.states = vec!["disabled"];
        let after = vec![changed, v("e3", "确定")];
        let d = diff(&before, &after);
        assert_eq!(d.added.len(), 1);
        assert_eq!(d.added[0].ref_id, "e3");
        assert_eq!(d.removed[0].ref_id, "e2");
        assert_eq!(d.changed[0].fields, vec![("states".into(), "".into(), "disabled".into())]);
    }

    #[test]
    fn appended_handles_scrolling_text() {
        assert_eq!(appended("a\nb", "a\nb\nc"), "\nc");
        assert_eq!(appended("l1\nl2\nl3", "l2\nl3\nl4\nl5"), "l4\nl5");
        assert_eq!(appended("zzz", "abc"), "abc");
    }

    #[test]
    fn diff_is_capped() {
        let after: Vec<ViewElement> = (0..MAX_DIFF_ITEMS + 3).map(|i| v(&format!("e{i}"), "x")).collect();
        let d = diff(&[], &after);
        assert_eq!(d.added.len(), MAX_DIFF_ITEMS);
        assert_eq!(d.omitted, 3);
    }
}
