//! A process-wide admission gate for complete data operations, not connection lifetimes.
//! Acquire before SQLite/JSONL/file work and release after all stores are updated.
//! New operations fail promptly during maintenance (including nested calls), so an
//! async runtime thread never blocks waiting for maintenance that is draining it.
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Default)]
struct State {
    operations: usize,
    maintenance: bool,
}

#[derive(Default)]
pub(crate) struct Gate {
    state: Mutex<State>,
    drained: Condvar,
}

pub(crate) struct OperationGuard {
    gate: Arc<Gate>,
}
pub(crate) struct MaintenanceGuard {
    gate: Arc<Gate>,
}

impl Gate {
    pub(crate) fn operation(self: &Arc<Self>) -> Result<OperationGuard, String> {
        let mut state = self.state.lock().map_err(|_| "数据维护锁不可用")?;
        if state.maintenance {
            return Err("数据正在备份或恢复，请稍后重试".into());
        }
        state.operations += 1;
        Ok(OperationGuard {
            gate: Arc::clone(self),
        })
    }

    pub(crate) fn maintenance(
        self: &Arc<Self>,
        timeout: Duration,
    ) -> Result<MaintenanceGuard, String> {
        let mut state = self.state.lock().map_err(|_| "数据维护锁不可用")?;
        if state.maintenance {
            return Err("已有备份或恢复正在进行，请稍后重试".into());
        }
        state.maintenance = true;
        let deadline = Instant::now() + timeout;
        while state.operations != 0 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                state.maintenance = false;
                return Err("数据操作尚未完成，未开始备份或恢复，请稍后重试".into());
            }
            let (next, _) = self
                .drained
                .wait_timeout(state, remaining)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state = next;
        }
        Ok(MaintenanceGuard {
            gate: Arc::clone(self),
        })
    }
}

impl Drop for OperationGuard {
    fn drop(&mut self) {
        let mut state = self.gate.state.lock().unwrap_or_else(|p| p.into_inner());
        state.operations -= 1;
        self.gate.drained.notify_all();
    }
}
impl Drop for MaintenanceGuard {
    fn drop(&mut self) {
        let mut state = self.gate.state.lock().unwrap_or_else(|p| p.into_inner());
        state.maintenance = false;
        self.gate.drained.notify_all();
    }
}

fn global() -> &'static Arc<Gate> {
    static GATE: OnceLock<Arc<Gate>> = OnceLock::new();
    GATE.get_or_init(|| Arc::new(Gate::default()))
}
pub(crate) fn operation() -> Result<OperationGuard, String> {
    global().operation()
}
pub(crate) fn maintenance() -> Result<MaintenanceGuard, String> {
    global().maintenance(Duration::from_secs(30))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drains_existing_operations_and_rejects_new_ones() {
        let gate = Arc::new(Gate::default());
        let operation = gate.operation().unwrap();
        let other = Arc::clone(&gate);
        let worker = std::thread::spawn(move || other.maintenance(Duration::from_secs(2)).unwrap());
        let deadline = Instant::now() + Duration::from_secs(2);
        while !gate.state.lock().unwrap().maintenance {
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        assert!(gate.operation().is_err());
        assert!(!worker.is_finished());
        drop(operation);
        let maintenance = worker.join().unwrap();
        assert!(gate.operation().is_err());
        drop(maintenance);
        assert!(gate.operation().is_ok());
    }
    #[test]
    fn timed_out_maintenance_reopens_admission() {
        let gate = Arc::new(Gate::default());
        let _operation = gate.operation().unwrap();
        assert!(gate.maintenance(Duration::ZERO).is_err());
        assert!(gate.operation().is_ok());
    }
    #[test]
    fn guards_can_cross_async_thread_boundaries() {
        fn send<T: Send>() {}
        send::<OperationGuard>();
        send::<MaintenanceGuard>();
    }
}
