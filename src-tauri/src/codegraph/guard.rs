//! Lock-safe drop helpers for CodeGraph.
//!
//! ## Why this exists
//! A Qdrant Edge `EdgeShard::drop` flushes on Drop and panics on IO error
//! (e.g. segment temp files missing — `os error 3` — removed by antivirus
//! scan or orphan-dir cleanup). When that drop happens while a
//! `CodeGraphState` lock is held (the build-thread swap of `inner`, or
//! `codegraph_close`'s `take`), the `RwLock`/`Mutex` poisons and every
//! subsequent `codegraph_build_index` returns
//! `Err("poisoned lock: another task failed inside")` — the persistent
//! "向量索引构建失败" failure that only a process restart clears.
//!
//! ## The fix
//! Move the drop of an old `ProjectIndex`/shard OUTSIDE any lock and catch
//! the panic, so a library drop-time panic can never poison shared state.
//! These are generic over `T` so they are unit-tested with a
//! drop-panicking test type — no Qdrant/ONNX dependency needed.

use std::sync::RwLock;

/// Drop `value`, catching any panic so a drop-time panic (e.g. Qdrant shard
/// flush IO error) never unwinds into the caller. The captured panic message
/// is logged with `label` for diagnostics. Used to drop an old `ProjectIndex`
/// or shard outside a lock so a library drop panic can't poison the lock.
pub fn drop_catching_panics<T>(value: T, label: &str) {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(value))) {
        Ok(()) => {}
        Err(payload) => {
            // Best-effort message extraction: panics carry &str / String /
            // anything else. Fall back to a generic note for non-string
            // payloads so the log line is always informative.
            let msg = payload
                .downcast_ref::<&str>()
                .copied()
                .or_else(|| payload.downcast_ref::<String>().map(|s| s.as_str()))
                .unwrap_or("(non-string panic payload)");
            tracing::warn!("codegraph: drop of {} panicked (suppressed): {}", label, msg);
        }
    }
}

/// Replace the value inside `lock` with `new`, returning the old value
/// WITHOUT dropping it inside the lock. The caller drops the returned old
/// value outside any lock (via [`drop_catching_panics`]) so a drop-time panic
/// never poisons the lock. This is the lock-safe swap for `CodeGraphState.inner`.
///
/// The write guard is released as soon as the swap is done (before the
/// caller drops the old value), so the lock is never held across a
/// potentially-panicking drop.
pub fn swap_returning_old<T>(lock: &RwLock<Option<T>>, new: T) -> Option<T> {
    let mut guard = match lock.write() {
        Ok(g) => g,
        // Lock already poisoned: return None rather than propagate, so a
        // previously-poisoned lock doesn't cascade. Caller proceeds with the
        // new index; the old (None) is simply absent.
        Err(_) => return None,
    };
    // `mem::replace` moves the old value OUT; the write guard is released when
    // it goes out of scope at the return — BEFORE the caller drops the old
    // value. So a drop-time panic in the old value can never poison this lock.
    std::mem::replace(&mut *guard, Some(new))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;

    /// A value that panics in Drop, simulating a Qdrant EdgeShard flush IO
    /// error during drop — the exact root cause of the poisoned-lock bug.
    struct PanicOnDrop;
    impl Drop for PanicOnDrop {
        fn drop(&mut self) {
            panic!("flush io error: 系统找不到指定的路径 (os error 3)");
        }
    }

    #[test]
    fn drop_catching_panics_suppresses_a_drop_panic() {
        // If the panic is NOT caught, this test unwinds and fails. Reaching
        // the assert means the drop panic was caught and never propagated.
        drop_catching_panics(PanicOnDrop, "panic-shard");
        assert!(true, "reached only if the drop panic was suppressed");
    }

    #[test]
    fn drop_catching_panics_still_drops_when_no_panic() {
        let dropped = Rc::new(Cell::new(false));
        struct Tracker(Rc<Cell<bool>>);
        impl Drop for Tracker {
            fn drop(&mut self) {
                self.0.set(true);
            }
        }
        drop_catching_panics(Tracker(dropped.clone()), "tracker");
        assert!(dropped.get(), "value must still be dropped when no panic occurs");
    }

    /// A value that panics in Drop only when its flag is set, letting one test
    /// value act as the panicking "old shard" while another is a calm "new".
    struct MaybePanicDrop(bool);
    impl Drop for MaybePanicDrop {
        fn drop(&mut self) {
            if self.0 {
                panic!("flush io error: 系统找不到指定的路径 (os error 3)");
            }
        }
    }

    #[test]
    fn swap_returning_old_returns_previous_value() {
        let lock = RwLock::new(Some(42i32));
        let old = swap_returning_old(&lock, 7);
        assert_eq!(old, Some(42), "must return the value that was in the lock");
        assert_eq!(*lock.read().unwrap(), Some(7), "lock now holds the new value");
    }

    /// The core anti-poison regression: swapping in a new value while the OLD
    /// value panics on drop must NOT poison the lock — because the old value is
    /// returned (dropped outside the lock) rather than dropped inside it. This
    /// is the exact shape of the `codegraph_build_index` Phase-1 swap that
    /// produced "poisoned lock: another task failed inside".
    #[test]
    fn swap_returning_old_keeps_lock_unpoisoned_when_old_drops_panicking() {
        let lock = std::sync::Arc::new(RwLock::new(Some(MaybePanicDrop(true)))); // old panics on drop
        let old = swap_returning_old(&lock, MaybePanicDrop(false)); // new won't panic
        assert!(old.is_some(), "swap must return the previous value to drop outside the lock");
        drop_catching_panics(old.unwrap(), "old-shard"); // old panics on drop → caught
        assert!(
            lock.write().is_ok(),
            "lock must not be poisoned when the old value drops outside it"
        );
        // Drain the calm new value so the test leaves no live guard holding it.
        drop_catching_panics(lock.write().unwrap().take(), "new-shard");
    }
}