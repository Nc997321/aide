// git 命令共享的输出归一化（core.quotepath 转义路径还原）。
// `pub(super)` 供 git/ 模块树内共享（compare/tags 也从这里拿）。
/// git 默认对含非 ASCII/特殊字符的路径做 C 风格引号转义（core.quotepath），
/// 形如 `"C\357\200\272foo.md"`（八进制字节转义 + 首尾双引号）。还原为真实
/// UTF-8 路径；无引号包裹的输入原样返回。
/// status/numstat/ls-files/ls-tree 的输出都受此规则影响，不还原会导致下游
/// 文件操作（删除/diff/撤回）拿到不存在的转义名而静默失败。
pub(super) fn unquote_git_path(s: &str) -> String {
    let bytes = s.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'"' || bytes[bytes.len() - 1] != b'"' {
        return s.to_string();
    }
    let inner = &bytes[1..bytes.len() - 1];
    let mut out: Vec<u8> = Vec::with_capacity(inner.len());
    let mut i = 0;
    while i < inner.len() {
        if inner[i] == b'\\' && i + 1 < inner.len() {
            match inner[i + 1] {
                b'0'..=b'7' => {
                    // 最多 3 位八进制 → 单字节
                    let mut val: u32 = 0;
                    let mut j = 0;
                    while j < 3
                        && i + 1 + j < inner.len()
                        && inner[i + 1 + j].is_ascii_digit()
                        && inner[i + 1 + j] < b'8'
                    {
                        val = val * 8 + (inner[i + 1 + j] - b'0') as u32;
                        j += 1;
                    }
                    out.push(val as u8);
                    i += 1 + j;
                }
                b'n' => {
                    out.push(b'\n');
                    i += 2;
                }
                b't' => {
                    out.push(b'\t');
                    i += 2;
                }
                b'b' => {
                    out.push(0x08);
                    i += 2;
                }
                b'f' => {
                    out.push(0x0C);
                    i += 2;
                }
                b'v' => {
                    out.push(0x0B);
                    i += 2;
                }
                b'\\' => {
                    out.push(b'\\');
                    i += 2;
                }
                b'"' => {
                    out.push(b'"');
                    i += 2;
                }
                other => {
                    out.push(other);
                    i += 2;
                }
            }
        } else {
            out.push(inner[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod unquote_tests {
    use super::unquote_git_path;

    #[test]
    fn plain_path_passthrough() {
        assert_eq!(unquote_git_path("src/api.ts"), "src/api.ts");
        assert_eq!(unquote_git_path("docs/设计.md"), "docs/设计.md");
    }

    #[test]
    fn octal_escaped_utf8_decoded() {
        // \357\200\272 = U+F03A（私用区，某些工具把文件名里的 ':' 映射到这里）
        assert_eq!(
            unquote_git_path("\"C\\357\\200\\272UsersheavenIdeaProjectsaidetest.md\""),
            "C\u{f03a}UsersheavenIdeaProjectsaidetest.md"
        );
        // 中文路径：设 = \350\256\276 计 = \350\256\241
        assert_eq!(
            unquote_git_path("\"docs/\\350\\256\\276\\350\\256\\241.md\""),
            "docs/设计.md"
        );
    }

    #[test]
    fn c_escapes_decoded() {
        assert_eq!(unquote_git_path("\"a\\nb.md\""), "a\nb.md");
        assert_eq!(unquote_git_path("\"a\\tb.md\""), "a\tb.md");
        assert_eq!(unquote_git_path("\"a\\\\b.md\""), "a\\b.md");
        assert_eq!(unquote_git_path("\"a\\\"b.md\""), "a\"b.md");
    }

    #[test]
    fn unmatched_or_short_quotes_passthrough() {
        assert_eq!(unquote_git_path("\"abc"), "\"abc");
        assert_eq!(unquote_git_path("abc\""), "abc\"");
        assert_eq!(unquote_git_path("\""), "\"");
    }
}
