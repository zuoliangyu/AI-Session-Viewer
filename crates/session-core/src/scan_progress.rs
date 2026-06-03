//! 冷启动扫描进度（best-effort 全局状态）。
//!
//! 初次启动时，provider 要并行扫描成百上千个会话文件来建缓存，这期间界面会
//! 几秒无响应。这里用一组全局原子记录"已扫描 / 总数 / 阶段"，前端在加载态轮询
//! [`snapshot`] 显示进度条，避免用户误以为卡死。
//!
//! 精度是尽力而为：扫描之间串行执行，偶有 watcher 后台扫描并发覆盖计数也只是
//! 让进度短暂跳动，不影响正确性。

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};

static ACTIVE: AtomicBool = AtomicBool::new(false);
static SCANNED: AtomicU64 = AtomicU64::new(0);
static TOTAL: AtomicU64 = AtomicU64::new(0);
static PHASE: AtomicU8 = AtomicU8::new(0);

/// 扫描阶段，决定前端展示的文案。
#[derive(Debug, Clone, Copy)]
pub enum Phase {
    Projects = 1,
    Sessions = 2,
    Index = 3,
}

/// 发给前端的进度快照。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub active: bool,
    pub scanned: u64,
    pub total: u64,
    pub phase: String,
}

fn phase_label(code: u8) -> String {
    match code {
        1 => "扫描项目",
        2 => "扫描会话",
        3 => "建立索引",
        _ => "扫描中",
    }
    .to_string()
}

/// 开始一段扫描：重置计数并标记 active。`total` 为预期处理的条目数。
pub fn begin(phase: Phase, total: u64) {
    PHASE.store(phase as u8, Ordering::Relaxed);
    TOTAL.store(total, Ordering::Relaxed);
    SCANNED.store(0, Ordering::Relaxed);
    ACTIVE.store(true, Ordering::Relaxed);
}

/// 完成一个条目（应在每次迭代结束时调用，无论结果是否被保留）。
pub fn inc() {
    SCANNED.fetch_add(1, Ordering::Relaxed);
}

/// 结束当前扫描段。
pub fn finish() {
    ACTIVE.store(false, Ordering::Relaxed);
}

/// 读取当前进度快照。
pub fn snapshot() -> ScanProgress {
    ScanProgress {
        active: ACTIVE.load(Ordering::Relaxed),
        scanned: SCANNED.load(Ordering::Relaxed),
        total: TOTAL.load(Ordering::Relaxed),
        phase: phase_label(PHASE.load(Ordering::Relaxed)),
    }
}

/// 把 rayon 全局线程池限制为「核数 − 1」（至少 1），给 UI 主线程留出一个核，
/// 否则冷启动并行扫描会吃满全部 CPU，导致界面（甚至整机）卡顿、连进度条都画
/// 不动。应在程序启动早期调用一次；重复调用或已初始化时静默忽略。
pub fn configure_rayon_pool() {
    let cores = std::thread::available_parallelism()
        .map(|c| c.get())
        .unwrap_or(1);
    let threads = cores.saturating_sub(1).max(1);
    let _ = rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .build_global();
}
