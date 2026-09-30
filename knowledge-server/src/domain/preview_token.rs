//! 取件票据：预览地址（`/p/{token}`）的签发与校验。
//!
//! 右栏内嵌浏览器是**直接导航**到取件地址的，地址栏发不出 `Authorization` 头
//! （这正是前端 `assetLoader.ts` 要绕道 objectURL 的同一个原因）。所以预览口
//! 用**不透明 token** 鉴权：token 只由已登录用户为自己的某一份条目签出，
//! 换不来任何别的权限（spec §4.5 / §4.6）。
//!
//! **只在内存里**：预览地址是「点一下马上打开」的短时票据，进程重启即失效是
//! 正确行为，不是缺陷（spec Review Focus #5 把它钉住）。第三步「发布」需要
//! 持久票据，届时另加一张表，不是把这个改成落库。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use uuid::Uuid;

/// 一张票据：换来哪一份条目、什么时候不再认。
#[derive(Debug, Clone, Copy)]
struct Ticket {
    document_id: Uuid,
    expires_at: i64,
}

#[derive(Default)]
pub struct PreviewTokens {
    tickets: Mutex<HashMap<String, Ticket>>,
}

impl PreviewTokens {
    pub fn new() -> Self {
        Self::default()
    }

    /// 签发一张票。返回 `(token, expires_at_unix_secs)`。
    ///
    /// token 用两个 v4 uuid 拼成 64 位十六进制——与登录会话令牌同一套做法，
    /// 不额外引随机源。256 位随机，枚举不动。
    pub fn mint(&self, document_id: Uuid, ttl_secs: i64) -> (String, i64) {
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let expires_at = now_unix() + ttl_secs;

        let mut tickets = self.lock();
        // 顺手清过期项：仓库是内存里的、量级是「一个人点了几次预览」，
        // 每次签发扫一遍比后台定时任务简单得多，也不会漏。
        let now = now_unix();
        tickets.retain(|_, t| t.expires_at > now);
        tickets.insert(
            token.clone(),
            Ticket {
                document_id,
                expires_at,
            },
        );

        (token, expires_at)
    }

    /// 兑现：有效则返回它换来的条目 id。未知、过期一律 `None`。
    pub fn redeem(&self, token: &str) -> Option<Uuid> {
        let mut tickets = self.lock();
        match tickets.get(token).copied() {
            Some(t) if t.expires_at > now_unix() => Some(t.document_id),
            Some(_) => {
                // 过期就地清掉：免得它一直躺在表里被反复判死
                tickets.remove(token);
                None
            }
            None => None,
        }
    }

    /// 这张票换的是哪一份条目（不判过期）。测试与诊断用。
    pub fn peek_owner(&self, token: &str) -> Option<Uuid> {
        self.lock().get(token).map(|t| t.document_id)
    }

    /// 锁中毒不当场 panic：票据仓不是不变量载体，最坏是少一张票（用户重开一次）。
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Ticket>> {
        self.tickets.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_unguessable_and_unique() {
        let store = PreviewTokens::new();
        let a = store.mint(Uuid::new_v4(), 60);
        let b = store.mint(Uuid::new_v4(), 60);
        assert_ne!(a.0, b.0);
        assert!(a.0.len() >= 32, "token 太短，可被枚举: {}", a.0.len());
    }

    /// Review Focus #5：过期与未知都必须明确失效。
    #[test]
    fn unknown_and_expired_tokens_are_rejected() {
        let store = PreviewTokens::new();
        assert!(store.redeem("nope").is_none(), "未知 token 不该被放行");

        let doc = Uuid::new_v4();
        let (token, _) = store.mint(doc, 0); // 立刻过期
        assert!(store.redeem(&token).is_none(), "过期 token 不该被放行");
    }

    #[test]
    fn redeem_returns_the_right_document() {
        let store = PreviewTokens::new();
        let doc = Uuid::new_v4();
        let (token, _) = store.mint(doc, 60);
        assert_eq!(store.redeem(&token), Some(doc));
    }

    /// 预览票据是**只读、且只对一份**的：别人的条目换不来，
    /// 也不存在「拿一个 token 探别的条目」这回事。
    #[test]
    fn token_grants_exactly_one_document() {
        let store = PreviewTokens::new();
        let mine = Uuid::new_v4();
        let other = Uuid::new_v4();
        let (token, _) = store.mint(mine, 60);

        assert_eq!(store.redeem(&token), Some(mine));
        assert_ne!(store.peek_owner(&token), Some(other));
        // 另一份条目没有票，拿不到
        assert!(store.redeem("some-other-token").is_none());
    }
}
