use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use tokio::sync::oneshot;

use super::session::MediaSession;
use super::types::FeedbackOutcome;

#[derive(Default)]
struct Inner {
    sessions: HashMap<String, Arc<MediaSession>>,
    epochs: HashMap<String, u64>,
}

pub(super) struct PendingFeedback {
    pub owner: String,
    pub sender: oneshot::Sender<Result<(), String>>,
}

#[derive(Default)]
pub(crate) struct MediaRegistry {
    inner: Mutex<Inner>,
    pending: Mutex<HashMap<String, PendingFeedback>>,
}

impl MediaRegistry {
    pub(super) fn epoch(&self, window: &str) -> u64 {
        *self.inner.lock().unwrap_or_else(PoisonError::into_inner).epochs.entry(window.to_string()).or_default()
    }

    pub(super) fn insert(&self, session: Arc<MediaSession>, epoch: u64) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        if inner.epochs.get(&session.owner).copied().unwrap_or(0) != epoch {
            return Err("Host 已切换，请重新打开媒体".into());
        }
        if inner.sessions.len() >= 32 {
            return Err("已打开的媒体标签过多，请先关闭一些标签".into());
        }
        inner.sessions.insert(session.token.clone(), session);
        Ok(())
    }

    pub(super) fn get(&self, token: &str) -> Option<Arc<MediaSession>> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner).sessions.get(token).cloned()
    }

    pub(super) fn for_view(&self, view: &str) -> Option<Arc<MediaSession>> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner).sessions.values()
            .find(|session| session.view_id().as_deref() == Some(view)).cloned()
    }

    pub(super) fn matching(&self, key: (&str, &str, &str)) -> Option<Arc<MediaSession>> {
        let inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        inner.sessions.values().find(|session| session.matches(key)).cloned()
    }

    pub(super) fn remove(&self, token: &str) {
        let session = self.inner.lock().unwrap_or_else(PoisonError::into_inner).sessions.remove(token);
        if let Some(session) = session { session.revoke(); }
    }

    pub(super) fn release_window(&self, window: &str) {
        let removed = self.take_window(window);
        for session in removed { session.revoke(); }
        self.reject_window_feedback(window);
    }

    fn take_window(&self, window: &str) -> Vec<Arc<MediaSession>> {
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        *inner.epochs.entry(window.to_string()).or_default() += 1;
        let keys: Vec<_> = inner.sessions.iter().filter(|(_, session)| session.owner == window)
            .map(|(key, _)| key.clone()).collect();
        keys.into_iter().filter_map(|key| inner.sessions.remove(&key)).collect()
    }

    pub(super) fn begin_feedback(&self, request: (String, PendingFeedback)) -> Result<(), String> {
        let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        if pending.len() >= 32 { return Err("待处理的媒体引用过多，请稍后再试".into()); }
        pending.insert(request.0, request.1);
        Ok(())
    }

    pub(super) fn cancel_feedback(&self, id: &str) {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner).remove(id);
    }

    pub(super) fn finish_feedback(&self, window: &str, id: &str, outcome: FeedbackOutcome) -> Result<(), String> {
        let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        let request = pending.get(id).ok_or("媒体反馈已结束或过期")?;
        if request.owner != window { return Err("媒体反馈不属于本窗口".into()); }
        let request = pending.remove(id).ok_or("媒体反馈已结束")?;
        request.sender.send(outcome.error.map_or(Ok(()), Err)).map_err(|_| "媒体页已停止等待反馈".to_string())
    }

    fn reject_window_feedback(&self, window: &str) {
        let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        let keys: Vec<_> = pending.iter().filter(|(_, value)| value.owner == window)
            .map(|(key, _)| key.clone()).collect();
        for key in keys {
            if let Some(request) = pending.remove(&key) {
                let _receiver_closed = request.sender.send(Err("原窗口或 Host 已关闭".into()));
            }
        }
    }
}

pub(super) fn token() -> String {
    rand::random::<[u8; 24]>().iter().map(|byte| format!("{byte:02x}")).collect()
}
