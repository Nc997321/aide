//! 固定容量环形缓冲：黑匣子的「最近 N 条」存储原语。
//!
//! 满员后 push 自动淘汰最旧一条。刻意不用 lock-free 结构——
//! 写入频率 ≤ 每秒几次，Mutex 包裹足够，简单性优先。

use std::collections::VecDeque;

pub struct Ring<T> {
    buf: VecDeque<T>,
    cap: usize,
}

impl<T> Ring<T> {
    pub fn new(cap: usize) -> Self {
        assert!(cap > 0, "ring capacity must be > 0");
        Self {
            buf: VecDeque::with_capacity(cap),
            cap,
        }
    }

    pub fn push(&mut self, item: T) {
        if self.buf.len() == self.cap {
            self.buf.pop_front();
        }
        self.buf.push_back(item);
    }

    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.buf.len()
    }
}

impl<T: Clone> Ring<T> {
    /// 快照为 Vec（旧 → 新），落盘报告用。
    pub fn to_vec(&self) -> Vec<T> {
        self.buf.iter().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_below_capacity_keeps_all() {
        let mut r = Ring::new(3);
        r.push(1);
        r.push(2);
        assert_eq!(r.to_vec(), vec![1, 2]);
        assert_eq!(r.len(), 2);
    }

    #[test]
    fn push_over_capacity_evicts_oldest() {
        let mut r = Ring::new(3);
        for i in 1..=5 {
            r.push(i);
        }
        assert_eq!(r.to_vec(), vec![3, 4, 5]);
        assert_eq!(r.len(), 3);
    }

    #[test]
    fn order_is_oldest_to_newest() {
        let mut r = Ring::new(2);
        r.push("a");
        r.push("b");
        r.push("c");
        assert_eq!(r.to_vec(), vec!["b", "c"]);
    }
}
