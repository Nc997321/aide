//! HTTP 字节选择；只支持单范围，多范围按 RFC 允许忽略并返回完整 200。

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ByteRange {
    pub start: u64,
    pub length: u64,
    pub partial: bool,
}

pub(crate) fn select(header: Option<&str>, size: u64) -> Result<ByteRange, ()> {
    let Some(header) = header else { return Ok(full(size)) };
    let (unit, value) = header.split_once('=').ok_or(())?;
    if !unit.trim().eq_ignore_ascii_case("bytes") { return Ok(full(size)); }
    if value.contains(',') { return Ok(full(size)); }
    let (start, end) = value.trim().split_once('-').ok_or(())?;
    if size == 0 { return Err(()); }
    let (start, end) = if start.is_empty() {
        let suffix = decimal(end)?;
        if suffix == 0 { return Err(()); }
        (size.saturating_sub(suffix), size - 1)
    } else {
        let start = decimal(start)?;
        let end = if end.is_empty() { size - 1 } else { decimal(end)?.min(size - 1) };
        if start >= size || start > end { return Err(()); }
        (start, end)
    };
    Ok(ByteRange { start, length: end - start + 1, partial: true })
}

fn full(size: u64) -> ByteRange { ByteRange { start: 0, length: size, partial: false } }
fn decimal(raw: &str) -> Result<u64, ()> {
    if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) { return Err(()); }
    raw.parse().map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closed_open_and_suffix_ranges() {
        assert_eq!(select(Some("bytes=3-6"), 10), Ok(ByteRange { start: 3, length: 4, partial: true }));
        assert_eq!(select(Some("bytes=7-"), 10), Ok(ByteRange { start: 7, length: 3, partial: true }));
        assert_eq!(select(Some("bytes=-3"), 10), Ok(ByteRange { start: 7, length: 3, partial: true }));
        assert_eq!(select(Some("bytes=-99"), 10), Ok(ByteRange { start: 0, length: 10, partial: true }));
        assert_eq!(select(Some("bytes=8-99"), 10), Ok(ByteRange { start: 8, length: 2, partial: true }));
    }
    #[test]
    fn invalid_ranges_do_not_overflow_or_read_past_eof() {
        for value in ["bytes=10-", "bytes=6-3", "bytes=-0", "bytes=a-b", "bytes=+1-2", "bytes=18446744073709551616-"] {
            assert_eq!(select(Some(value), 10), Err(()), "{value}");
        }
        assert_eq!(select(Some("bytes=0-"), 0), Err(()));
        assert_eq!(select(None, 0), Ok(full(0)));
        assert_eq!(select(Some("bytes=0-1,5-6"), 10), Ok(full(10)));
    }
}
