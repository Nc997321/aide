//! 可搜文本的唯一产地。
//!
//! 「条目 = 原件 + 派生可搜文本」（spec §4.1）。派生文本**允许失真**——它只服务检索，
//! agent 读到的永远是原件。所以这里剥标记可以糙，但**不能把脚本内容搜出来**，
//! 那是让人搜不到正文的噪声。
//!
//! 放在 domain 而不是 adapter：它是纯文本变换，不是文件解析；解析端口是文件级的
//! （`parse(path)`），而编辑保存也要重算可搜文本（spec Review Focus #4），
//! 两条路必须共用同一份规则——否则编辑过的 html 会留着旧的搜索内容。

/// `None` = 与 `content` 相同（md 及一切「原文即可搜」的条目）。
pub fn derive(mime: &str, content: &str) -> Option<String> {
    match mime {
        "text/html" => Some(html_to_text(content)),
        // 刻意**只**认 html：产品里没有 csv / json（spec §5.1），真出现也走
        // 「原文即可搜」，不在这里给它们开后门。
        _ => None,
    }
}

/// 粗剥 HTML，只服务于检索。
///
/// 明确**不做**的事（够用即可，别扩）：
/// - 不解码实体：`&amp;` 保持原样（搜"&"命中不到词，可接受）
/// - 不判 CSS 隐藏：`display:none` 的文字仍会被搜到
/// - 不还原表格结构：单元格只当成词
fn html_to_text(html: &str) -> String {
    const RAW: [&str; 2] = ["script", "style"];
    let mut out = String::with_capacity(html.len() / 2);
    let mut rest = html;

    loop {
        let Some(lt) = rest.find('<') else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..lt]);

        let after = &rest[lt + 1..];
        let Some(gt) = after.find('>') else {
            // 未闭合的 '<' 当正文
            out.push_str(&rest[lt..]);
            break;
        };

        let tag = after[..gt].trim();
        let name = tag
            .trim_start_matches('/')
            .split(|c: char| c.is_whitespace() || c == '/')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();

        // raw 元素：整段跳到它自己的结束标签之后（脚本体绝不进可搜文本）
        if !tag.starts_with('/') && RAW.contains(&name.as_str()) {
            rest = skip_raw_element(&after[gt + 1..], &name);
            continue;
        }

        // 注释 / 声明整段丢掉；其余标签一律当一个分隔符，别把相邻的词粘成一个
        if !tag.starts_with('!') {
            out.push(' ');
        }
        rest = &after[gt + 1..];
    }

    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 从 raw 元素的正文里跳到 `</name>` 之后。找不到结束标签就吃到末尾。
fn skip_raw_element<'a>(after_open: &'a str, name: &str) -> &'a str {
    let close = format!("</{name}");
    let Some(pos) = find_ascii_ci(after_open, &close) else {
        return "";
    };
    let tail = &after_open[pos + close.len()..];
    tail.find('>').map_or("", |q| &tail[q + 1..])
}

/// 大小写不敏感的 ASCII 查找。
///
/// ⚠️ 实现是「整串 `to_ascii_lowercase` 后 `find`」——返回的字节下标与原串一致，
/// 前提是转换不改字节长度。ASCII 大小写折叠逐字节等长，**非 ASCII 字节原样保留**，
/// 所以这个前提恒成立（这里也只用它找 `</script` / `</style`，全是 ASCII）。
fn find_ascii_ci(haystack: &str, needle_lower: &str) -> Option<usize> {
    haystack.to_ascii_lowercase().find(needle_lower)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_has_no_separate_search_text() {
        assert_eq!(derive("text/markdown", "# 标题\n正文"), None);
    }

    /// Review Focus #2：脚本与样式的内容不该被搜出来。
    #[test]
    fn drops_script_and_style_bodies() {
        let html = "<html><head><style>.a{color:red}</style>\
                    <script>var secretName=1;</script></head>\
                    <body><p>季度复盘</p></body></html>";
        let text = derive("text/html", html).unwrap();
        assert!(text.contains("季度复盘"), "正文没被抽出来: {text}");
        assert!(!text.contains("secretName"), "脚本内容混进了可搜文本: {text}");
        assert!(!text.contains("color:red"), "样式内容混进了可搜文本: {text}");
    }

    #[test]
    fn drops_tags_but_keeps_words_apart() {
        let text = derive("text/html", "<h1>一季度</h1><p>复盘</p>").unwrap();
        assert_eq!(text, "一季度 复盘");
    }

    #[test]
    fn drops_comments() {
        let text = derive("text/html", "a<!-- 草稿 -->b").unwrap();
        assert!(!text.contains("草稿"), "注释混进了可搜文本: {text}");
    }

    #[test]
    fn only_html_needs_a_separate_search_text() {
        // 反向钉住范围：产品里没有 csv / json（spec §5.1），
        // 真出现也一律走「原文即可搜」，不在这里给它们开后门。
        assert_eq!(derive("text/csv", "a,b\n1,2"), None);
        assert_eq!(derive("application/json", "{\"a\":1}"), None);
        assert_eq!(derive("text/plain", "一句话"), None);
    }

    /// 大写标签名同样要认（html 对标签名不区分大小写）。
    #[test]
    fn raw_elements_are_case_insensitive() {
        let text = derive("text/html", "<SCRIPT>var leaked=1;</SCRIPT><p>正文</p>").unwrap();
        assert!(!text.contains("leaked"), "大写 SCRIPT 没被跳过: {text}");
        assert!(text.contains("正文"));
    }

    /// 没闭合的 raw 元素：宁可丢一点正文，也不能把脚本吐出来。
    #[test]
    fn unclosed_script_does_not_leak_or_hang() {
        let text = derive("text/html", "<p>前</p><script>var leaked=1;").unwrap();
        assert!(!text.contains("leaked"), "未闭合脚本泄漏了: {text}");
        assert!(text.contains('前'));
    }
}
