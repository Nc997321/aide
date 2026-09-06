//! jieba-rs 分词适配器。
//!
//! 换分词算法时，只需在这里加一个新文件实现 `Tokenizer`，
//! 然后在装配处（main）替换掉 `JiebaTokenizer`——`domain` 与 `api` 不用动。

use jieba_rs::Jieba;

use crate::port::Tokenizer;

pub struct JiebaTokenizer {
    jieba: Jieba,
}

impl JiebaTokenizer {
    pub fn new() -> Self {
        Self {
            jieba: Jieba::new(),
        }
    }
}

impl Default for JiebaTokenizer {
    fn default() -> Self {
        Self::new()
    }
}

impl Tokenizer for JiebaTokenizer {
    fn id(&self) -> &'static str {
        "jieba-rs"
    }

    fn cut(&self, text: &str) -> Vec<String> {
        // hmm=false：不用新词发现模式，保证同一段文本的分词结果稳定。
        // 检索要求「写入时和查询时切出同样的词」，稳定性比召回率重要。
        // jieba-rs 0.10 的 cut() 返回 Vec<Token<'_>> 而不是 Vec<&str>，
        // Token 上带 word / start / end，这里只取词本身。
        self.jieba
            .cut(text, false)
            .into_iter()
            .map(|t| t.word.to_string())
            .collect()
    }
}
