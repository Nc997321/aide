//! extract.rs 的独立单元测试文件——由 extract.rs 末尾的
//! `#[cfg(test)] mod extract_tests;` 引入：可访问本模块私有项，
//! 且 release 构建不编译（与内嵌 mod tests 等价，只是文件独立）。

use super::*;
use crate::codegraph::parser::ParserManager;
use std::path::Path;

/// Java 多字段声明 `int a, b;` 的 `field_declaration` 节点**没有** name 字段
/// （名字在 declarator → variable_declarator 里）——extract_field 的
/// `child_by_field_name("name")` 对它返回 None，靠底部递归的
/// `variable_declarator` 兜住索引。本测试覆盖该 None 臂（分支 248:9），
/// 并验证 Java 多字段声明全部被索引、parent 正确（无回归）。
#[test]
fn java_multi_field_declaration_indexes_each_identifier() {
    let pm = ParserManager::new();
    let src = "class Repo {\n    int a, b;\n    void save() {}\n}";
    let (points, _) = extract_symbols(Path::new("Repo.java"), src, &pm, Path::new(""));
    for name in ["a", "b"] {
        let f = points
            .iter()
            .find(|p| p.symbol.name == name)
            .unwrap_or_else(|| panic!("field `{name}` must be indexed"));
        assert_eq!(f.symbol.kind, SymbolKind::Field);
        assert_eq!(f.symbol.parent.as_deref(), Some("Repo"));
    }
}
