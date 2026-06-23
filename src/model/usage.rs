//! API Key 用量追踪模块
//!
//! 记录每个 API Key 的请求用量（input/output tokens），并根据模型定价估算费用。
//!
//! 内部按 `(api_key_id, model)` 维度做内存聚合（只存累计值，不存明细），
//! 由后台任务定时落盘到 `api_key_usage.json`。
//! 这样 `record` 是纯内存操作（不碰磁盘），`get_summary`/`get_total_cost`
//! 的复杂度从 O(明细数) 降到 O(模型数)，避免高 RPM 下的雪崩。

use chrono::{DateTime, Utc};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// 单条用量记录
///
/// 仅用于**兼容解析**旧版明细格式的 `api_key_usage.json`，
/// 加载后会立即聚合进内存结构，运行期不再产生明细。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    /// API Key ID（0 = 主密钥）
    pub api_key_id: u32,
    /// 模型名称
    pub model: String,
    /// 输入 tokens
    pub input_tokens: i32,
    /// 输出 tokens
    pub output_tokens: i32,
    /// 缓存命中 tokens（从 input_tokens 中拆分，按折扣计费）
    #[serde(default)]
    pub cache_read_tokens: i32,
    /// 估算费用（美元）
    pub estimated_cost: f64,
    /// 记录时间
    pub created_at: DateTime<Utc>,
}

/// 单个 API Key 的用量汇总
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    /// API Key ID
    pub api_key_id: u32,
    /// 总请求次数
    pub total_requests: u64,
    /// 总输入 tokens
    pub total_input_tokens: i64,
    /// 总输出 tokens
    pub total_output_tokens: i64,
    /// 总估算费用（美元）
    pub total_cost: f64,
    /// 按模型分组的用量
    pub by_model: Vec<ModelUsage>,
}
/// 按模型分组的用量
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub requests: u64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost: f64,
}

/// 模型定价（每百万 tokens，美元）
/// 使用 200K context 标准定价
struct ModelPricing {
    input_per_mtok: f64,
    output_per_mtok: f64,
}

/// 根据模型名获取定价
fn get_model_pricing(model: &str) -> ModelPricing {
    let model_lower = model.to_lowercase();

    if model_lower.contains("opus") {
        // Opus 4: $15 / $75
        ModelPricing {
            input_per_mtok: 15.0,
            output_per_mtok: 75.0,
        }
    } else if model_lower.contains("haiku") {
        // Haiku 4.5: $1 / $5
        ModelPricing {
            input_per_mtok: 1.0,
            output_per_mtok: 5.0,
        }
    } else {
        // Sonnet 4: $3 / $15（默认）
        ModelPricing {
            input_per_mtok: 3.0,
            output_per_mtok: 15.0,
        }
    }
}

/// 缓存命中 tokens 的折扣系数（五折）
const CACHE_READ_DISCOUNT: f64 = 0.5;

/// 计算单次请求的估算费用
///
/// `cache_read_tokens` 是从 `input_tokens` 中拆分出的缓存命中部分，
/// 按 `CACHE_READ_DISCOUNT` 折扣计费。
fn calculate_cost(model: &str, input_tokens: i32, output_tokens: i32, cache_read_tokens: i32) -> f64 {
    let pricing = get_model_pricing(model);
    let fresh_input = (input_tokens - cache_read_tokens).max(0);
    let fresh_cost = (fresh_input as f64 / 1_000_000.0) * pricing.input_per_mtok;
    let cache_cost = (cache_read_tokens as f64 / 1_000_000.0) * pricing.input_per_mtok * CACHE_READ_DISCOUNT;
    let output_cost = (output_tokens as f64 / 1_000_000.0) * pricing.output_per_mtok;
    fresh_cost + cache_cost + output_cost
}

/// 单个 `(api_key, model)` 的聚合累计值（内存 + 持久化共用）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelAggregate {
    requests: u64,
    input_tokens: i64,
    output_tokens: i64,
    cost: f64,
}

/// 持久化格式：`{ "<api_key_id>": { "<model>": ModelAggregate } }`
///
/// 用 `String` 作为 key 是因为 JSON 对象 key 必须是字符串。
type AggregateMap = HashMap<u32, HashMap<String, ModelAggregate>>;
/// 用量追踪器（线程安全）
///
/// 内部维护按 `(api_key_id, model)` 聚合的累计值，`record` 仅更新内存并置脏，
/// 由后台任务调用 [`UsageTracker::flush_if_dirty`] 定时落盘。
pub struct UsageTracker {
    /// 聚合数据：api_key_id -> (model -> 累计值)
    aggregates: RwLock<AggregateMap>,
    /// 是否有未落盘的更新
    dirty: AtomicBool,
    file_path: PathBuf,
}

impl UsageTracker {
    /// 从文件加载，兼容新（聚合）/旧（明细数组）两种格式；文件不存在则创建空表
    pub fn load<P: AsRef<Path>>(path: P) -> anyhow::Result<Self> {
        let path = path.as_ref().to_path_buf();
        let aggregates = if path.exists() {
            let content = fs::read_to_string(&path)?;
            parse_content(&content)?
        } else {
            HashMap::new()
        };
        Ok(Self {
            aggregates: RwLock::new(aggregates),
            dirty: AtomicBool::new(false),
            file_path: path,
        })
    }

    /// 将当前聚合数据落盘（无条件写）
    fn flush(&self) -> anyhow::Result<()> {
        // 锁内只做 clone（O(keys*models)，极小），尽快释放锁再序列化写盘
        let snapshot = self.aggregates.read().clone();
        let content = serde_json::to_string(&snapshot)?;
        if let Some(parent) = self.file_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&self.file_path, content)?;
        Ok(())
    }

    /// 若有未落盘更新则落盘（供后台定时任务调用）
    ///
    /// 先抢占式清除 dirty 标志，再写盘：即便写盘期间有新 record 也会重新置脏，
    /// 下一轮被捕获，不会丢更新。
    pub fn flush_if_dirty(&self) {
        if self
            .dirty
            .compare_exchange(true, false, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return; // 无脏数据
        }
        if let Err(e) = self.flush() {
            tracing::warn!("保存用量记录失败: {}", e);
            // 写盘失败，重新置脏以便下轮重试
            self.dirty.store(true, Ordering::Release);
        }
    }

    /// 记录一次请求用量（纯内存操作，不碰磁盘）
    pub fn record(
        &self,
        api_key_id: u32,
        model: String,
        input_tokens: i32,
        output_tokens: i32,
        cache_read_tokens: i32,
    ) {
        let cost = calculate_cost(&model, input_tokens, output_tokens, cache_read_tokens);
        {
            let mut aggregates = self.aggregates.write();
            let entry = aggregates
                .entry(api_key_id)
                .or_default()
                .entry(model)
                .or_default();
            entry.requests += 1;
            entry.input_tokens += input_tokens as i64;
            entry.output_tokens += output_tokens as i64;
            entry.cost += cost;
        }
        self.dirty.store(true, Ordering::Release);
    }

    /// 获取单个 API Key 的用量汇总
    pub fn get_summary(&self, api_key_id: u32) -> UsageSummary {
        let aggregates = self.aggregates.read();
        let by_model: Vec<ModelUsage> = aggregates
            .get(&api_key_id)
            .map(|models| {
                models
                    .iter()
                    .map(|(model, agg)| ModelUsage {
                        model: model.clone(),
                        requests: agg.requests,
                        input_tokens: agg.input_tokens,
                        output_tokens: agg.output_tokens,
                        cost: agg.cost,
                    })
                    .collect()
            })
            .unwrap_or_default();

        UsageSummary {
            api_key_id,
            total_requests: by_model.iter().map(|m| m.requests).sum(),
            total_input_tokens: by_model.iter().map(|m| m.input_tokens).sum(),
            total_output_tokens: by_model.iter().map(|m| m.output_tokens).sum(),
            total_cost: by_model.iter().map(|m| m.cost).sum(),
            by_model,
        }
    }

    /// 获取所有 API Key 的用量概览
    pub fn get_all_summaries(&self) -> Vec<UsageSummary> {
        let key_ids: Vec<u32> = {
            let aggregates = self.aggregates.read();
            let mut ids: Vec<u32> = aggregates.keys().copied().collect();
            ids.sort();
            ids
        };
        key_ids.iter().map(|&id| self.get_summary(id)).collect()
    }

    /// 重置指定 API Key 的用量记录（低频管理操作，立即落盘）
    pub fn reset(&self, api_key_id: u32) -> anyhow::Result<()> {
        {
            let mut aggregates = self.aggregates.write();
            aggregates.remove(&api_key_id);
        }
        let result = self.flush();
        // flush 已落盘最新状态，可清除 dirty
        if result.is_ok() {
            self.dirty.store(false, Ordering::Release);
        }
        result
    }

    /// 获取指定 API Key 的累计费用（轻量版，仅算总费用）
    pub fn get_total_cost(&self, api_key_id: u32) -> f64 {
        let aggregates = self.aggregates.read();
        aggregates
            .get(&api_key_id)
            .map(|models| models.values().map(|agg| agg.cost).sum())
            .unwrap_or(0.0)
    }
}

impl Drop for UsageTracker {
    fn drop(&mut self) {
        // 进程退出兜底：把最后一批未落盘的聚合写下去
        if self.dirty.load(Ordering::Acquire) {
            if let Err(e) = self.flush() {
                tracing::warn!("退出前保存用量记录失败: {}", e);
            }
        }
    }
}

/// 解析文件内容：先试新聚合格式，失败再按旧明细数组聚合
fn parse_content(content: &str) -> anyhow::Result<AggregateMap> {
    if content.trim().is_empty() {
        return Ok(HashMap::new());
    }
    // 1. 新格式：聚合 map
    if let Ok(map) = serde_json::from_str::<AggregateMap>(content) {
        return Ok(map);
    }
    // 2. 旧格式：明细数组 -> 聚合
    let records: Vec<UsageRecord> = serde_json::from_str(content)?;
    Ok(aggregate_records(records))
}

/// 把旧版明细记录聚合成内存结构
fn aggregate_records(records: Vec<UsageRecord>) -> AggregateMap {
    let mut map: AggregateMap = HashMap::new();
    for r in records {
        let entry = map
            .entry(r.api_key_id)
            .or_default()
            .entry(r.model)
            .or_default();
        entry.requests += 1;
        entry.input_tokens += r.input_tokens as i64;
        entry.output_tokens += r.output_tokens as i64;
        entry.cost += r.estimated_cost;
    }
    map
}
#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("kiro-usage-{}-{}.json", name, uuid::Uuid::new_v4()))
    }

    #[test]
    fn test_record_and_summary() {
        let path = tmp_path("rec");
        let tracker = UsageTracker::load(&path).unwrap();
        tracker.record(1, "claude-sonnet-4".into(), 1000, 500, 0);
        tracker.record(1, "claude-sonnet-4".into(), 2000, 800, 200);

        let summary = tracker.get_summary(1);
        assert_eq!(summary.total_requests, 2);
        assert_eq!(summary.total_input_tokens, 3000);
        assert_eq!(summary.total_output_tokens, 1300);
        assert_eq!(summary.by_model.len(), 1);
        assert!(summary.total_cost > 0.0);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn test_get_total_cost_only_target_key() {
        let path = tmp_path("cost");
        let tracker = UsageTracker::load(&path).unwrap();
        tracker.record(1, "claude-sonnet-4".into(), 1000, 500, 0);
        tracker.record(2, "claude-opus-4".into(), 1000, 500, 0);

        let c1 = tracker.get_total_cost(1);
        let c2 = tracker.get_total_cost(2);
        assert!(c1 > 0.0 && c2 > 0.0);
        // opus 更贵
        assert!(c2 > c1);
        assert_eq!(tracker.get_total_cost(999), 0.0);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn test_flush_and_reload_roundtrip() {
        let path = tmp_path("roundtrip");
        {
            let tracker = UsageTracker::load(&path).unwrap();
            tracker.record(1, "claude-sonnet-4".into(), 1000, 500, 0);
            tracker.flush_if_dirty();
        }
        // 重新加载应保留累计值
        let tracker2 = UsageTracker::load(&path).unwrap();
        let summary = tracker2.get_summary(1);
        assert_eq!(summary.total_requests, 1);
        assert_eq!(summary.total_input_tokens, 1000);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn test_backward_compat_legacy_detail_format() {
        let path = tmp_path("legacy");
        // 写入旧版明细数组格式
        let legacy = r#"[
            {"apiKeyId":1,"model":"claude-sonnet-4","inputTokens":1000,"outputTokens":500,"estimatedCost":0.0105,"createdAt":"2024-01-01T00:00:00Z"},
            {"apiKeyId":1,"model":"claude-sonnet-4","inputTokens":2000,"outputTokens":300,"estimatedCost":0.0105,"createdAt":"2024-01-01T00:01:00Z"}
        ]"#;
        std::fs::write(&path, legacy).unwrap();

        let tracker = UsageTracker::load(&path).unwrap();
        let summary = tracker.get_summary(1);
        assert_eq!(summary.total_requests, 2);
        assert_eq!(summary.total_input_tokens, 3000);
        assert_eq!(summary.total_output_tokens, 800);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn test_reset() {
        let path = tmp_path("reset");
        let tracker = UsageTracker::load(&path).unwrap();
        tracker.record(1, "claude-sonnet-4".into(), 1000, 500, 0);
        tracker.record(2, "claude-sonnet-4".into(), 1000, 500, 0);
        tracker.reset(1).unwrap();
        assert_eq!(tracker.get_total_cost(1), 0.0);
        assert!(tracker.get_total_cost(2) > 0.0);
        let _ = std::fs::remove_file(&path);
    }
}
