//! The hidden write session only needs to stay loaded while writes are close together.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const IDLE_FOR: Duration = Duration::from_secs(30);

pub(super) struct IdleCleanup {
    pending: Mutex<Option<tokio::task::JoinHandle<()>>>,
    retiring: AtomicBool,
}

impl IdleCleanup {
    pub(super) const fn new() -> Self { Self { pending: Mutex::new(None), retiring: AtomicBool::new(false) } }

    pub(super) fn cancel(&self) {
        if let Some(task) = self.pending.lock().unwrap_or_else(|e| e.into_inner()).take() {
            task.abort();
        }
    }

    pub(super) fn retire(&self) {
        self.retiring.store(true, Ordering::SeqCst);
    }

    /// Native destroy queues an event. Cancellation must not make its old handle reusable.
    pub(super) async fn wait_for_retirement(&self, registered: impl Fn() -> bool) {
        if !self.retiring.load(Ordering::SeqCst) { return; }
        while registered() {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        self.retiring.store(false, Ordering::SeqCst);
    }

    pub(super) fn arm(&self, writing: &'static tokio::sync::Mutex<()>, cleanup: impl FnOnce() + Send + 'static) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(task) = pending.take() {
            task.abort();
        }
        *pending = Some(tokio::spawn(async move {
            tokio::time::sleep(IDLE_FOR).await;
            // Cancellation also removes a task already waiting for a write to finish. Once
            // this lock is held, cleanup is synchronous: a new write cannot overtake it.
            let _write = writing.lock().await;
            cleanup();
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn cleanup_count(count: &Arc<AtomicUsize>) -> impl FnOnce() + Send + 'static {
        let count = count.clone();
        move || { count.fetch_add(1, Ordering::SeqCst); }
    }

    async fn tick(seconds: u64) {
        // Let the spawned task register its timer before advancing the paused clock.
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(seconds)).await;
        tokio::task::yield_now().await;
    }

    #[tokio::test(start_paused = true)]
    async fn hidden_session_expires_after_thirty_idle_seconds() {
        static WRITING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        let idle = IdleCleanup::new();
        let count = Arc::new(AtomicUsize::new(0));
        idle.arm(&WRITING, cleanup_count(&count));
        tick(29).await;
        assert_eq!(count.load(Ordering::SeqCst), 0);
        tick(1).await;
        assert_eq!(count.load(Ordering::SeqCst), 1);
        tick(30).await;
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn cancelling_before_a_write_keeps_its_session_alive() {
        static WRITING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        let idle = IdleCleanup::new();
        let count = Arc::new(AtomicUsize::new(0));
        idle.arm(&WRITING, cleanup_count(&count));
        tick(29).await;
        idle.cancel();
        tick(30).await;
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_new_idle_period_replaces_the_previous_deadline() {
        static WRITING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        let idle = IdleCleanup::new();
        let count = Arc::new(AtomicUsize::new(0));
        idle.arm(&WRITING, cleanup_count(&count));
        tick(29).await;
        idle.arm(&WRITING, cleanup_count(&count));
        tick(1).await;
        assert_eq!(count.load(Ordering::SeqCst), 0);
        tick(29).await;
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn expiry_waits_for_the_active_write() {
        static WRITING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        let idle = IdleCleanup::new();
        let count = Arc::new(AtomicUsize::new(0));
        let write = WRITING.lock().await;
        idle.arm(&WRITING, cleanup_count(&count));
        tick(30).await;
        assert_eq!(count.load(Ordering::SeqCst), 0);
        drop(write);
        tokio::task::yield_now().await;
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn cancellation_removes_expired_cleanup_waiting_for_the_write_lock() {
        static WRITING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        let idle = IdleCleanup::new();
        let count = Arc::new(AtomicUsize::new(0));
        let write = WRITING.lock().await;
        idle.arm(&WRITING, cleanup_count(&count));
        tick(30).await;
        idle.cancel();
        drop(write);
        let new_write = WRITING.lock().await;
        tick(30).await;
        drop(new_write);
        tokio::task::yield_now().await;
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn cancelling_expiry_cannot_reuse_a_session_with_deferred_native_teardown() {
        use std::sync::atomic::AtomicBool;
        static WRITING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        let idle = Arc::new(IdleCleanup::new());
        let registered = Arc::new(AtomicBool::new(true));
        let writes = Arc::new(AtomicUsize::new(0));
        idle.arm(&WRITING, {
            let idle = idle.clone();
            // Native destroy only queues teardown; the old session remains registered.
            move || idle.retire()
        });
        tick(30).await;
        idle.cancel();
        let next_write = tokio::spawn({
            let idle = idle.clone();
            let registered = registered.clone();
            let writes = writes.clone();
            async move {
                let _write = WRITING.lock().await;
                idle.wait_for_retirement(|| registered.load(Ordering::SeqCst)).await;
                writes.fetch_add(1, Ordering::SeqCst);
            }
        });
        tick(1).await;
        assert_eq!(writes.load(Ordering::SeqCst), 0);
        registered.store(false, Ordering::SeqCst);
        tick(1).await;
        next_write.await.unwrap();
        assert_eq!(writes.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn dropping_a_retirement_wait_does_not_let_another_write_reuse_the_old_session() {
        use std::sync::atomic::AtomicBool;
        let idle = Arc::new(IdleCleanup::new());
        let registered = Arc::new(AtomicBool::new(true));
        idle.retire();
        let abandoned = tokio::spawn({
            let idle = idle.clone();
            let registered = registered.clone();
            async move { idle.wait_for_retirement(|| registered.load(Ordering::SeqCst)).await }
        });
        tick(1).await;
        abandoned.abort();
        let wait = idle.wait_for_retirement(|| registered.load(Ordering::SeqCst));
        assert!(tokio::time::timeout(Duration::from_secs(1), wait).await.is_err());
        registered.store(false, Ordering::SeqCst);
        idle.wait_for_retirement(|| registered.load(Ordering::SeqCst)).await;
    }
}
