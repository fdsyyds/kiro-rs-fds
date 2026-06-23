//! 错误日志收集器
//!
//! 内存环形缓冲区，记录最近的 API 请求错误，供 Admin UI 查看排查。

use std::collections::VecDeque;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// 单条错误日志记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorLogEntry {
    /// 请求 ID
    pub request_id: String,
    /// 发生时间
    pub timestamp: DateTime<Utc>,
    /// 请求的 endpoint（如 /v1/messages）
    pub endpoint: String,
    /// 请求使用的模型名
    pub model: Option<String>,
    /// 使用的凭据 ID
    pub credential_id: Option<u64>,
    /// API Key ID（0=主密钥）
    pub api_key_id: Option<u32>,
    /// 客户端 IP（如果可获取）
    pub client_ip: Option<String>,
    /// 错误类型（如 api_error, invalid_request_error）
    pub error_type: String,
    /// 错误消息
    pub error_message: String,
    /// 返回给客户端的 HTTP 状态码
    pub status_code: u16,
    /// 上游返回的原始错误响应（如果有）
    pub upstream_response: Option<String>,
    /// 请求体摘要（截断到一定长度，避免内存爆炸）
    pub request_body: Option<String>,
}

/// 错误日志收集器（线程安全，环形缓冲区）
#[derive(Clone)]
pub struct ErrorLogger {
    inner: Arc<Mutex<VecDeque<ErrorLogEntry>>>,
    capacity: usize,
}

impl ErrorLogger {
    /// 创建新的错误日志收集器
    ///
    /// `capacity`: 最多保留多少条记录
    pub fn new(capacity: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(VecDeque::with_capacity(capacity))),
            capacity,
        }
    }

    /// 记录一条错误
    pub fn log(&self, entry: ErrorLogEntry) {
        let mut buffer = self.inner.lock();
        if buffer.len() >= self.capacity {
            buffer.pop_front();
        }
        buffer.push_back(entry);
    }

    /// 获取所有错误日志（最新的在最后）
    pub fn get_all(&self) -> Vec<ErrorLogEntry> {
        self.inner.lock().iter().cloned().collect()
    }

    /// 获取最近 N 条错误日志（最新的在前）
    pub fn get_recent(&self, limit: usize) -> Vec<ErrorLogEntry> {
        let buffer = self.inner.lock();
        buffer.iter().rev().take(limit).cloned().collect()
    }

    /// 清空所有错误日志
    pub fn clear(&self) {
        self.inner.lock().clear();
    }

    /// 当前记录数量
    pub fn len(&self) -> usize {
        self.inner.lock().len()
    }
}
