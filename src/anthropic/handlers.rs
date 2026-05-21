//! Anthropic API Handler 函数

use std::convert::Infallible;

use crate::kiro::model::events::Event;
use crate::kiro::model::requests::kiro::KiroRequest;
use crate::kiro::parser::decoder::EventStreamDecoder;
use crate::token;
use anyhow::Error;
use axum::{
    Extension, Json as JsonExtractor,
    body::Body,
    extract::State,
    http::{StatusCode, header},
    response::{IntoResponse, Json, Response},
};
use bytes::Bytes;
use futures::{Stream, StreamExt, stream};
use serde_json::json;
use std::time::{Duration, Instant};
use tokio::time::interval;
use uuid::Uuid;

use super::converter::{ConversionError, convert_request};
use super::middleware::{ApiKeyContext, AppState};
use super::stream::{DelayedStreamContext, SseEvent, StreamContext};
use super::types::{
    CountTokensRequest, CountTokensResponse, ErrorResponse, MessagesRequest, Model, ModelsResponse,
    OutputConfig, Thinking,
};
use super::websearch;

fn log_request_stage(
    request_id: &str,
    endpoint: &str,
    stage: &str,
    stage_start: Instant,
    request_start: Instant,
) {
    tracing::info!(
        request_id = %request_id,
        endpoint = endpoint,
        stage = stage,
        stage_ms = stage_start.elapsed().as_millis(),
        elapsed_ms = request_start.elapsed().as_millis(),
        "request_timing"
    );
}

/// GET /v1/ping
///
/// 诊断端点（无需认证），返回请求的关键信息，用于排查客户端连接问题
pub async fn ping(request: axum::http::Request<Body>) -> impl IntoResponse {
    let method = request.method().to_string();
    let uri = request.uri().to_string();
    let headers: serde_json::Map<String, serde_json::Value> = request
        .headers()
        .iter()
        .filter(|(name, _)| {
            let n = name.as_str();
            // 只返回有用的 header，隐藏 API key
            n != "x-api-key" && n != "authorization"
        })
        .map(|(name, value)| {
            (
                name.to_string(),
                serde_json::Value::String(value.to_str().unwrap_or("<binary>").to_string()),
            )
        })
        .collect();

    Json(json!({
        "status": "ok",
        "method": method,
        "uri": uri,
        "headers": headers,
        "models_count": build_model_list().len(),
        "hint": "If you see this, the proxy is reachable. Try GET /v1/models with your API key to verify auth."
    }))
}

/// 将 KiroProvider 错误映射为 HTTP 响应
fn map_provider_error(err: Error) -> Response {
    let err_str = err.to_string();

    // 上下文窗口满了（对话历史累积超出模型上下文窗口限制）
    if err_str.contains("CONTENT_LENGTH_EXCEEDS_THRESHOLD") {
        tracing::warn!(error = %err, "上游拒绝请求：上下文窗口已满（不应重试）");
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse::new(
                "invalid_request_error",
                "Context window is full. Reduce conversation history, system prompt, or tools.",
            )),
        )
            .into_response();
    }

    // 单次输入太长（请求体本身超出上游限制）
    if err_str.contains("Input is too long") {
        tracing::warn!(error = %err, "上游拒绝请求：输入过长（不应重试）");
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse::new(
                "invalid_request_error",
                "Input is too long. Reduce the size of your messages.",
            )),
        )
            .into_response();
    }
    tracing::error!("Kiro API 调用失败: {}", err);
    (
        StatusCode::BAD_GATEWAY,
        Json(ErrorResponse::new(
            "api_error",
            format!("上游 API 调用失败: {}", err),
        )),
    )
        .into_response()
}

/// GET /v1/models
///
/// 返回可用的模型列表
pub async fn get_models() -> impl IntoResponse {
    tracing::info!("Received GET /v1/models request");

    Json(ModelsResponse {
        object: "list".to_string(),
        data: build_model_list(),
    })
}

/// 构建可用模型列表（供 get_models 和 get_model 共用）
fn build_model_list() -> Vec<Model> {
    vec![
        // === 旧版模型 ID（兼容旧版 Claude Code 客户端） ===
        // 这些旧 ID 在 map_model() 中会被正确映射到对应的 Kiro 模型
        Model {
            id: "claude-3-5-sonnet-20241022".to_string(),
            object: "model".to_string(),
            created: 1729555200,
            owned_by: "anthropic".to_string(),
            display_name: "Claude 3.5 Sonnet".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 8192,
        },
        Model {
            id: "claude-3-5-haiku-20241022".to_string(),
            object: "model".to_string(),
            created: 1729555200,
            owned_by: "anthropic".to_string(),
            display_name: "Claude 3.5 Haiku".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 8192,
        },
        Model {
            id: "claude-3-opus-20240229".to_string(),
            object: "model".to_string(),
            created: 1709164800,
            owned_by: "anthropic".to_string(),
            display_name: "Claude 3 Opus".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 4096,
        },
        Model {
            id: "claude-3-haiku-20240307".to_string(),
            object: "model".to_string(),
            created: 1709769600,
            owned_by: "anthropic".to_string(),
            display_name: "Claude 3 Haiku".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 4096,
        },
        Model {
            id: "claude-3-sonnet-20240229".to_string(),
            object: "model".to_string(),
            created: 1709164800,
            owned_by: "anthropic".to_string(),
            display_name: "Claude 3 Sonnet".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 4096,
        },
        // === Claude 4.x 过渡期模型 ID ===
        Model {
            id: "claude-sonnet-4-20250514".to_string(),
            object: "model".to_string(),
            created: 1747180800,
            owned_by: "anthropic".to_string(),
            display_name: "Claude Sonnet 4".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 16000,
        },
        Model {
            id: "claude-opus-4-20250514".to_string(),
            object: "model".to_string(),
            created: 1747180800,
            owned_by: "anthropic".to_string(),
            display_name: "Claude Opus 4".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 16000,
        },
        // === 当前主力模型 ===
        Model {
            id: "claude-sonnet-4-5-20250929".to_string(),
            object: "model".to_string(),
            created: 1727568000,
            owned_by: "anthropic".to_string(),
            display_name: "Claude Sonnet 4.5".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 32000,
        },
        Model {
            id: "claude-sonnet-4-5-20250929-thinking".to_string(),
            object: "model".to_string(),
            created: 1727568000,
            owned_by: "anthropic".to_string(),
            display_name: "Claude Sonnet 4.5 (Thinking)".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 32000,
        },
        Model {
            id: "claude-opus-4-5-20251101".to_string(),
            object: "model".to_string(),
            created: 1730419200,
            owned_by: "anthropic".to_string(),
            display_name: "Claude Opus 4.5".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 32000,
        },
        Model {
            id: "claude-opus-4-5-20251101-thinking".to_string(),
            object: "model".to_string(),
            created: 1730419200,
            owned_by: "anthropic".to_string(),
            display_name: "Claude Opus 4.5 (Thinking)".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 32000,
        },
        Model {
            id: "claude-sonnet-4-6".to_string(),
            object: "model".to_string(),
            created: 1770314400,
            owned_by: "anthropic".to_string(),
            display_name: "Claude Sonnet 4.6".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 32000,
        },
        Model {
            id: "claude-sonnet-4-6-thinking".to_string(),
            object: "model".to_string(),
            created: 1770314400,
            owned_by: "anthropic".to_string(),
            display_name: "Claude Sonnet 4.6 (Thinking)".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 32000,
        },
        Model {
            id: "claude-opus-4-6".to_string(),
            object: "model".to_string(),
            created: 1770314400,
            owned_by: "anthropic".to_string(),
            display_name: "Claude Opus 4.6".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 32000,
        },
        Model {
            id: "claude-opus-4-6-thinking".to_string(),
            object: "model".to_string(),
            created: 1770314400,
            owned_by: "anthropic".to_string(),
            display_name: "Claude Opus 4.6 (Thinking)".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 32000,
        },
        Model {
            id: "claude-opus-4-7".to_string(),
            object: "model".to_string(),
            created: 1774000000,
            owned_by: "anthropic".to_string(),
            display_name: "Claude Opus 4.7".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 32000,
        },
        Model {
            id: "claude-opus-4-7-thinking".to_string(),
            object: "model".to_string(),
            created: 1774000000,
            owned_by: "anthropic".to_string(),
            display_name: "Claude Opus 4.7 (Thinking)".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 32000,
        },
        Model {
            id: "claude-haiku-4-5-20251001".to_string(),
            object: "model".to_string(),
            created: 1727740800,
            owned_by: "anthropic".to_string(),
            display_name: "Claude Haiku 4.5".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 32000,
        },
        Model {
            id: "claude-haiku-4-5-20251001-thinking".to_string(),
            object: "model".to_string(),
            created: 1727740800,
            owned_by: "anthropic".to_string(),
            display_name: "Claude Haiku 4.5 (Thinking)".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 32000,
        },
    ]
}

/// GET /v1/models/:model_id
///
/// 返回指定模型的信息
pub async fn get_model(axum::extract::Path(model_id): axum::extract::Path<String>) -> Response {
    tracing::info!(model_id = %model_id, "Received GET /v1/models/:model_id request");

    // 复用 get_models 的模型列表，查找匹配的模型
    let models = build_model_list();
    if let Some(model) = models.into_iter().find(|m| m.id == model_id) {
        Json(model).into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse::new(
                "not_found_error",
                format!("Model '{}' not found", model_id),
            )),
        )
            .into_response()
    }
}

/// POST /v1/messages
///
/// 创建消息（对话）
pub async fn post_messages(
    State(state): State<AppState>,
    identity: Option<Extension<ApiKeyContext>>,
    JsonExtractor(mut payload): JsonExtractor<MessagesRequest>,
) -> Response {
    let request_id = Uuid::new_v4().to_string();
    let request_start = Instant::now();
    let endpoint = "/v1/messages";
    tracing::info!(
        request_id = %request_id,
        model = %payload.model,
        max_tokens = %payload.max_tokens,
        stream = %payload.stream,
        message_count = %payload.messages.len(),
        "Received POST /v1/messages request"
    );

    // 记录 RPM（全局 + per-API-Key）
    if let Some(rpm_tracker) = &state.rpm_tracker {
        let stage_start = Instant::now();
        let api_key_id = identity.as_ref().map(|ext| ext.0.id);
        rpm_tracker.record_request(api_key_id);
        log_request_stage(
            &request_id,
            endpoint,
            "record_rpm",
            stage_start,
            request_start,
        );
    }

    // 检查 KiroProvider 是否可用
    let stage_start = Instant::now();
    let provider = match &state.kiro_provider {
        Some(p) => p.clone(),
        None => {
            tracing::error!("KiroProvider 未配置");
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(ErrorResponse::new(
                    "service_unavailable",
                    "Kiro API provider not configured",
                )),
            )
                .into_response();
        }
    };
    log_request_stage(
        &request_id,
        endpoint,
        "provider_lookup",
        stage_start,
        request_start,
    );

    // 检测模型名是否包含 "thinking" 后缀，若包含则覆写 thinking 配置
    let stage_start = Instant::now();
    override_thinking_from_model_name(&mut payload);
    log_request_stage(
        &request_id,
        endpoint,
        "override_thinking",
        stage_start,
        request_start,
    );

    // 检查是否为 WebSearch 请求
    let stage_start = Instant::now();
    let is_websearch = websearch::has_web_search_tool(&payload);
    log_request_stage(
        &request_id,
        endpoint,
        "detect_websearch",
        stage_start,
        request_start,
    );
    if is_websearch {
        tracing::info!("检测到 WebSearch 工具，路由到 WebSearch 处理");

        // 估算输入 tokens
        let stage_start = Instant::now();
        let input_tokens = token::count_all_tokens(
            payload.model.clone(),
            payload.system.clone(),
            payload.messages.clone(),
            payload.tools.clone(),
        )
        .await as i32;
        log_request_stage(
            &request_id,
            endpoint,
            "count_tokens_websearch",
            stage_start,
            request_start,
        );

        return websearch::handle_websearch_request(provider, &payload, input_tokens).await;
    }

    // 转换请求
    let stage_start = Instant::now();
    let conversion_result = match convert_request(&payload) {
        Ok(result) => result,
        Err(e) => {
            let (error_type, message) = match &e {
                ConversionError::UnsupportedModel(model) => {
                    ("invalid_request_error", format!("模型不支持: {}", model))
                }
                ConversionError::EmptyMessages => {
                    ("invalid_request_error", "消息列表为空".to_string())
                }
            };
            tracing::warn!("请求转换失败: {}", e);
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse::new(error_type, message)),
            )
                .into_response();
        }
    };
    log_request_stage(
        &request_id,
        endpoint,
        "convert_request",
        stage_start,
        request_start,
    );

    // 构建 Kiro 请求
    let stage_start = Instant::now();
    let kiro_request = KiroRequest {
        conversation_state: conversion_result.conversation_state,
        profile_arn: state.profile_arn.clone(),
    };
    log_request_stage(
        &request_id,
        endpoint,
        "build_kiro_request",
        stage_start,
        request_start,
    );

    let stage_start = Instant::now();
    let request_body = match serde_json::to_string(&kiro_request) {
        Ok(body) => body,
        Err(e) => {
            tracing::error!("序列化请求失败: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse::new(
                    "internal_error",
                    format!("序列化请求失败: {}", e),
                )),
            )
                .into_response();
        }
    };
    log_request_stage(
        &request_id,
        endpoint,
        "serialize_kiro_request",
        stage_start,
        request_start,
    );

    tracing::debug!("Kiro request body: {}", request_body);

    // 估算最后一条消息的 tokens（非缓存部分）
    let stage_start = Instant::now();
    let last_msg_tokens = token::count_last_message_tokens(&payload.messages) as i32;
    log_request_stage(
        &request_id,
        endpoint,
        "count_last_message_tokens",
        stage_start,
        request_start,
    );

    // 估算输入 tokens（诊断：记录耗时）
    let t_count_start = std::time::Instant::now();
    let input_tokens = token::count_all_tokens(
        payload.model.clone(),
        payload.system,
        payload.messages,
        payload.tools,
    )
    .await as i32;
    let count_tokens_ms = t_count_start.elapsed().as_millis();
    if count_tokens_ms > 500 {
        tracing::warn!(
            request_id = %request_id,
            count_tokens_ms = count_tokens_ms,
            input_tokens = input_tokens,
            "count_all_tokens 耗时过长"
        );
    }
    log_request_stage(
        &request_id,
        endpoint,
        "count_all_tokens",
        t_count_start,
        request_start,
    );

    // 缓存命中 tokens = 总 input - 最后一条消息
    let stage_start = Instant::now();
    let cache_read_tokens = (input_tokens - last_msg_tokens).max(0);
    log_request_stage(
        &request_id,
        endpoint,
        "calculate_cache_tokens",
        stage_start,
        request_start,
    );

    // 检查是否启用了thinking
    let stage_start = Instant::now();
    let thinking_enabled = payload
        .thinking
        .as_ref()
        .map(|t| t.is_enabled())
        .unwrap_or(false);
    log_request_stage(
        &request_id,
        endpoint,
        "detect_thinking",
        stage_start,
        request_start,
    );

    // 提取用量追踪信息
    let stage_start = Instant::now();
    let api_key_id = identity.map(|ext| ext.0.id);
    let usage_tracker = state.usage_tracker.clone();
    log_request_stage(
        &request_id,
        endpoint,
        "prepare_usage_tracking",
        stage_start,
        request_start,
    );

    // 获取 Token 倍率
    let stage_start = Instant::now();
    let input_multiplier = provider.token_manager().get_input_multiplier();
    let output_multiplier = provider.token_manager().get_output_multiplier();
    log_request_stage(
        &request_id,
        endpoint,
        "load_token_multipliers",
        stage_start,
        request_start,
    );

    if payload.stream {
        // 流式响应
        handle_stream_request(
            provider,
            &request_body,
            &payload.model,
            input_tokens,
            cache_read_tokens,
            thinking_enabled,
            usage_tracker,
            api_key_id,
            input_multiplier,
            output_multiplier,
            request_id,
            endpoint,
            request_start,
        )
        .await
    } else {
        // 非流式响应
        handle_non_stream_request(
            provider,
            &request_body,
            &payload.model,
            input_tokens,
            cache_read_tokens,
            usage_tracker,
            api_key_id,
            input_multiplier,
            output_multiplier,
            request_id,
            endpoint,
            request_start,
        )
        .await
    }
}

/// 处理流式请求
async fn handle_stream_request(
    provider: std::sync::Arc<crate::kiro::provider::KiroProvider>,
    request_body: &str,
    model: &str,
    input_tokens: i32,
    cache_read_tokens: i32,
    thinking_enabled: bool,
    usage_tracker: Option<std::sync::Arc<crate::model::usage::UsageTracker>>,
    api_key_id: Option<u32>,
    input_multiplier: f64,
    output_multiplier: f64,
    request_id: String,
    endpoint: &'static str,
    request_start: Instant,
) -> Response {
    // 调用 Kiro API（支持多凭据故障转移）
    let stage_start = Instant::now();
    let response = match provider.call_api_stream(request_body).await {
        Ok(resp) => resp,
        Err(e) => return map_provider_error(e),
    };
    log_request_stage(
        &request_id,
        endpoint,
        "provider_stream_response_headers",
        stage_start,
        request_start,
    );

    // 创建流处理上下文
    let stage_start = Instant::now();
    let mut ctx = StreamContext::new_with_thinking(model, input_tokens, thinking_enabled)
        .with_cache_read_tokens(cache_read_tokens)
        .with_usage_tracking(usage_tracker, api_key_id)
        .with_multipliers(input_multiplier, output_multiplier);
    log_request_stage(
        &request_id,
        endpoint,
        "create_stream_context",
        stage_start,
        request_start,
    );

    // 生成初始事件
    let stage_start = Instant::now();
    let initial_events = ctx.generate_initial_events();
    log_request_stage(
        &request_id,
        endpoint,
        "generate_initial_sse_events",
        stage_start,
        request_start,
    );

    // 创建 SSE 流
    let stream = create_sse_stream(
        response,
        ctx,
        initial_events,
        request_id.clone(),
        endpoint,
        request_start,
    );

    // 返回 SSE 响应
    log_request_stage(
        &request_id,
        endpoint,
        "response_ready",
        request_start,
        request_start,
    );
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, "keep-alive")
        .body(Body::from_stream(stream))
        .unwrap()
}

/// Ping 事件间隔（25秒）
const PING_INTERVAL_SECS: u64 = 25;

/// 创建 ping 事件的 SSE 字符串
fn create_ping_sse() -> Bytes {
    Bytes::from("event: ping\ndata: {\"type\": \"ping\"}\n\n")
}

/// 创建 SSE 事件流
fn create_sse_stream(
    response: reqwest::Response,
    ctx: StreamContext,
    initial_events: Vec<SseEvent>,
    request_id: String,
    endpoint: &'static str,
    request_start: Instant,
) -> impl Stream<Item = Result<Bytes, Infallible>> {
    // 先发送初始事件
    let initial_stream = stream::iter(
        initial_events
            .into_iter()
            .map(|e| Ok(Bytes::from(e.to_sse_string()))),
    );

    // 然后处理 Kiro 响应流，同时每25秒发送 ping 保活
    let body_stream = response.bytes_stream();
    let stream_start = Instant::now();

    let processing_stream = stream::unfold(
        (
            body_stream,
            ctx,
            EventStreamDecoder::new(),
            false,
            interval(Duration::from_secs(PING_INTERVAL_SECS)),
            request_id,
            endpoint,
            request_start,
            stream_start,
            false,
            false,
        ),
        |(
            mut body_stream,
            mut ctx,
            mut decoder,
            finished,
            mut ping_interval,
            request_id,
            endpoint,
            request_start,
            stream_start,
            mut first_upstream_chunk_logged,
            mut first_model_sse_logged,
        )| async move {
            if finished {
                return None;
            }

            // 使用 select! 同时等待数据和 ping 定时器
            tokio::select! {
                // 处理数据流
                chunk_result = body_stream.next() => {
                    match chunk_result {
                        Some(Ok(chunk)) => {
                            if !first_upstream_chunk_logged {
                                log_request_stage(
                                    &request_id,
                                    endpoint,
                                    "stream_first_upstream_chunk",
                                    stream_start,
                                    request_start,
                                );
                                first_upstream_chunk_logged = true;
                            }

                            // 解码事件
                            if let Err(e) = decoder.feed(&chunk) {
                                tracing::warn!("缓冲区溢出: {}", e);
                            }

                            let mut events = Vec::new();
                            for result in decoder.decode_iter() {
                                match result {
                                    Ok(frame) => {
                                        if let Ok(event) = Event::from_frame(frame) {
                                            let sse_events = ctx.process_kiro_event(&event);
                                            events.extend(sse_events);
                                        }
                                    }
                                    Err(e) => {
                                        tracing::warn!("解码事件失败: {}", e);
                                    }
                                }
                            }

                            // 转换为 SSE 字节流
                            let bytes: Vec<Result<Bytes, Infallible>> = events
                                .into_iter()
                                .map(|e| Ok(Bytes::from(e.to_sse_string())))
                                .collect();

                            if !bytes.is_empty() && !first_model_sse_logged {
                                log_request_stage(
                                    &request_id,
                                    endpoint,
                                    "stream_first_model_sse_events",
                                    stream_start,
                                    request_start,
                                );
                                first_model_sse_logged = true;
                            }

                            Some((
                                stream::iter(bytes),
                                (
                                    body_stream,
                                    ctx,
                                    decoder,
                                    false,
                                    ping_interval,
                                    request_id,
                                    endpoint,
                                    request_start,
                                    stream_start,
                                    first_upstream_chunk_logged,
                                    first_model_sse_logged,
                                ),
                            ))
                        }
                        Some(Err(e)) => {
                            tracing::error!("读取响应流失败: {}", e);
                            // 发送最终事件并结束
                            let final_events = ctx.generate_final_events();
                            let bytes: Vec<Result<Bytes, Infallible>> = final_events
                                .into_iter()
                                .map(|e| Ok(Bytes::from(e.to_sse_string())))
                                .collect();
                            Some((
                                stream::iter(bytes),
                                (
                                    body_stream,
                                    ctx,
                                    decoder,
                                    true,
                                    ping_interval,
                                    request_id,
                                    endpoint,
                                    request_start,
                                    stream_start,
                                    first_upstream_chunk_logged,
                                    first_model_sse_logged,
                                ),
                            ))
                        }
                        None => {
                            // 流结束，发送最终事件
                            let final_events = ctx.generate_final_events();
                            let bytes: Vec<Result<Bytes, Infallible>> = final_events
                                .into_iter()
                                .map(|e| Ok(Bytes::from(e.to_sse_string())))
                                .collect();
                            Some((
                                stream::iter(bytes),
                                (
                                    body_stream,
                                    ctx,
                                    decoder,
                                    true,
                                    ping_interval,
                                    request_id,
                                    endpoint,
                                    request_start,
                                    stream_start,
                                    first_upstream_chunk_logged,
                                    first_model_sse_logged,
                                ),
                            ))
                        }
                    }
                }
                // 发送 ping 保活
                _ = ping_interval.tick() => {
                    tracing::trace!("发送 ping 保活事件");
                    let bytes: Vec<Result<Bytes, Infallible>> = vec![Ok(create_ping_sse())];
                    Some((
                        stream::iter(bytes),
                        (
                            body_stream,
                            ctx,
                            decoder,
                            false,
                            ping_interval,
                            request_id,
                            endpoint,
                            request_start,
                            stream_start,
                            first_upstream_chunk_logged,
                            first_model_sse_logged,
                        ),
                    ))
                }
            }
        },
    )
    .flatten();

    initial_stream.chain(processing_stream)
}

/// 上下文窗口大小（1M tokens）
const CONTEXT_WINDOW_SIZE: i32 = 1_000_000;

/// 处理非流式请求
async fn handle_non_stream_request(
    provider: std::sync::Arc<crate::kiro::provider::KiroProvider>,
    request_body: &str,
    model: &str,
    input_tokens: i32,
    cache_read_tokens: i32,
    usage_tracker: Option<std::sync::Arc<crate::model::usage::UsageTracker>>,
    api_key_id: Option<u32>,
    input_multiplier: f64,
    output_multiplier: f64,
    request_id: String,
    endpoint: &'static str,
    request_start: Instant,
) -> Response {
    // 调用 Kiro API（支持多凭据故障转移）
    let stage_start = Instant::now();
    let response = match provider.call_api(request_body).await {
        Ok(resp) => resp,
        Err(e) => return map_provider_error(e),
    };
    log_request_stage(
        &request_id,
        endpoint,
        "provider_non_stream_response_headers",
        stage_start,
        request_start,
    );

    // 读取响应体
    let stage_start = Instant::now();
    let body_bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(e) => {
            tracing::error!("读取响应体失败: {}", e);
            return (
                StatusCode::BAD_GATEWAY,
                Json(ErrorResponse::new(
                    "api_error",
                    format!("读取响应失败: {}", e),
                )),
            )
                .into_response();
        }
    };
    log_request_stage(
        &request_id,
        endpoint,
        "read_non_stream_body",
        stage_start,
        request_start,
    );

    // 解析事件流
    let stage_start = Instant::now();
    let mut decoder = EventStreamDecoder::new();
    if let Err(e) = decoder.feed(&body_bytes) {
        tracing::warn!("缓冲区溢出: {}", e);
    }

    let mut text_content = String::new();
    let mut tool_uses: Vec<serde_json::Value> = Vec::new();
    let mut has_tool_use = false;
    let mut stop_reason = "end_turn".to_string();
    // 从 contextUsageEvent 计算的实际输入 tokens
    let mut context_input_tokens: Option<i32> = None;

    // 收集工具调用的增量 JSON
    let mut tool_json_buffers: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();

    for result in decoder.decode_iter() {
        match result {
            Ok(frame) => {
                if let Ok(event) = Event::from_frame(frame) {
                    match event {
                        Event::AssistantResponse(resp) => {
                            text_content.push_str(&resp.content);
                        }
                        Event::ToolUse(tool_use) => {
                            has_tool_use = true;

                            // 累积工具的 JSON 输入
                            let buffer = tool_json_buffers
                                .entry(tool_use.tool_use_id.clone())
                                .or_insert_with(String::new);
                            buffer.push_str(&tool_use.input);

                            // 如果是完整的工具调用，添加到列表
                            if tool_use.stop {
                                let input: serde_json::Value = if buffer.is_empty() {
                                    serde_json::json!({})
                                } else {
                                    serde_json::from_str(buffer).unwrap_or_else(|e| {
                                        tracing::warn!(
                                            "工具输入 JSON 解析失败: {}, tool_use_id: {}",
                                            e,
                                            tool_use.tool_use_id
                                        );
                                        serde_json::json!({})
                                    })
                                };

                                tool_uses.push(json!({
                                    "type": "tool_use",
                                    "id": tool_use.tool_use_id,
                                    "name": tool_use.name,
                                    "input": input
                                }));
                            }
                        }
                        Event::ContextUsage(context_usage) => {
                            // 从上下文使用百分比计算实际的 input_tokens
                            // 公式: percentage * 200000 / 100 = percentage * 2000
                            let actual_input_tokens = (context_usage.context_usage_percentage
                                * (CONTEXT_WINDOW_SIZE as f64)
                                / 100.0)
                                as i32;
                            context_input_tokens = Some(actual_input_tokens);
                            // 上下文使用量达到 100% 时，设置 stop_reason 为 model_context_window_exceeded
                            if context_usage.context_usage_percentage >= 100.0 {
                                stop_reason = "model_context_window_exceeded".to_string();
                            }
                            tracing::debug!(
                                "收到 contextUsageEvent: {}%, 计算 input_tokens: {}",
                                context_usage.context_usage_percentage,
                                actual_input_tokens
                            );
                        }
                        Event::Exception { exception_type, .. } => {
                            if exception_type == "ContentLengthExceededException" {
                                stop_reason = "max_tokens".to_string();
                            }
                        }
                        _ => {}
                    }
                }
            }
            Err(e) => {
                tracing::warn!("解码事件失败: {}", e);
            }
        }
    }

    // 确定 stop_reason
    if has_tool_use && stop_reason == "end_turn" {
        stop_reason = "tool_use".to_string();
    }

    // 构建响应内容
    let mut content: Vec<serde_json::Value> = Vec::new();

    if !text_content.is_empty() {
        content.push(json!({
            "type": "text",
            "text": text_content
        }));
    }

    content.extend(tool_uses);

    // 估算输出 tokens
    let output_tokens = token::estimate_output_tokens(&content);

    log_request_stage(
        &request_id,
        endpoint,
        "decode_non_stream_events",
        stage_start,
        request_start,
    );

    // 使用从 contextUsageEvent 计算的 input_tokens，如果没有则使用估算值
    let final_input_tokens = context_input_tokens.unwrap_or(input_tokens);

    // 按实际 input tokens 等比例调整 cache_read_tokens
    let final_cache_read = if final_input_tokens != input_tokens && input_tokens > 0 {
        ((cache_read_tokens as f64) * (final_input_tokens as f64) / (input_tokens as f64)) as i32
    } else {
        cache_read_tokens
    };

    // 记录用量
    if let (Some(tracker), Some(key_id)) = (&usage_tracker, api_key_id) {
        tracker.record(
            key_id,
            model.to_string(),
            final_input_tokens,
            output_tokens,
            final_cache_read,
        );
    }

    // 构建 Anthropic 响应（应用 Token 倍率）
    let reported_input = (final_input_tokens as f64 * input_multiplier) as i32;
    let reported_output = (output_tokens as f64 * output_multiplier) as i32;
    let response_body = json!({
        "id": format!("msg_{}", Uuid::new_v4().to_string().replace('-', "")),
        "type": "message",
        "role": "assistant",
        "content": content,
        "model": model,
        "stop_reason": stop_reason,
        "stop_sequence": null,
        "usage": {
            "input_tokens": reported_input,
            "output_tokens": reported_output
        }
    });

    log_request_stage(
        &request_id,
        endpoint,
        "build_non_stream_response",
        request_start,
        request_start,
    );
    (StatusCode::OK, Json(response_body)).into_response()
}

/// 检测模型名是否包含 "thinking" 后缀，若包含则覆写 thinking 配置
///
/// - Opus 4.6/4.7：覆写为 adaptive 类型
/// - 其他模型：覆写为 enabled 类型
/// - budget_tokens 固定为 20000
fn override_thinking_from_model_name(payload: &mut MessagesRequest) {
    let model_lower = payload.model.to_lowercase();
    if !model_lower.contains("thinking") {
        return;
    }

    let is_opus_adaptive = model_lower.contains("opus")
        && (model_lower.contains("4-6")
            || model_lower.contains("4.6")
            || model_lower.contains("4-7")
            || model_lower.contains("4.7"));

    let thinking_type = if is_opus_adaptive {
        "adaptive"
    } else {
        "enabled"
    };

    tracing::info!(
        model = %payload.model,
        thinking_type = thinking_type,
        "模型名包含 thinking 后缀，覆写 thinking 配置"
    );

    payload.thinking = Some(Thinking {
        thinking_type: thinking_type.to_string(),
        budget_tokens: 20000,
    });

    if is_opus_adaptive {
        payload.output_config = Some(OutputConfig {
            effort: "high".to_string(),
        });
    }
}

/// POST /v1/messages/count_tokens
///
/// 计算消息的 token 数量
pub async fn count_tokens(
    JsonExtractor(payload): JsonExtractor<CountTokensRequest>,
) -> impl IntoResponse {
    tracing::info!(
        model = %payload.model,
        message_count = %payload.messages.len(),
        "Received POST /v1/messages/count_tokens request"
    );

    let total_tokens = token::count_all_tokens(
        payload.model,
        payload.system,
        payload.messages,
        payload.tools,
    )
    .await as i32;

    Json(CountTokensResponse {
        input_tokens: total_tokens.max(1) as i32,
    })
}

/// POST /cc/v1/messages
///
/// Claude Code 兼容端点，与 /v1/messages 的区别在于：
/// - 流式响应会等待 kiro 端返回 contextUsageEvent 后再发送 message_start
/// - message_start 中的 input_tokens 是从 contextUsageEvent 计算的准确值
pub async fn post_messages_cc(
    State(state): State<AppState>,
    identity: Option<Extension<ApiKeyContext>>,
    JsonExtractor(mut payload): JsonExtractor<MessagesRequest>,
) -> Response {
    let request_id = Uuid::new_v4().to_string();
    let request_start = Instant::now();
    let endpoint = "/cc/v1/messages";
    let provider_lookup_start = Instant::now();
    tracing::info!(
        request_id = %request_id,
        model = %payload.model,
        max_tokens = %payload.max_tokens,
        stream = %payload.stream,
        message_count = %payload.messages.len(),
        "Received POST /cc/v1/messages request"
    );

    // 检查 KiroProvider 是否可用
    let provider = match &state.kiro_provider {
        Some(p) => p.clone(),
        None => {
            tracing::error!("KiroProvider 未配置");
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(ErrorResponse::new(
                    "service_unavailable",
                    "Kiro API provider not configured",
                )),
            )
                .into_response();
        }
    };
    log_request_stage(
        &request_id,
        endpoint,
        "provider_lookup",
        provider_lookup_start,
        request_start,
    );

    // 检测模型名是否包含 "thinking" 后缀，若包含则覆写 thinking 配置
    let stage_start = Instant::now();
    override_thinking_from_model_name(&mut payload);
    log_request_stage(
        &request_id,
        endpoint,
        "override_thinking",
        stage_start,
        request_start,
    );

    // 检查是否为 WebSearch 请求
    let stage_start = Instant::now();
    let is_websearch = websearch::has_web_search_tool(&payload);
    log_request_stage(
        &request_id,
        endpoint,
        "detect_websearch",
        stage_start,
        request_start,
    );
    if is_websearch {
        tracing::info!("检测到 WebSearch 工具，路由到 WebSearch 处理");

        // 估算输入 tokens
        let stage_start = Instant::now();
        let input_tokens = token::count_all_tokens(
            payload.model.clone(),
            payload.system.clone(),
            payload.messages.clone(),
            payload.tools.clone(),
        )
        .await as i32;
        log_request_stage(
            &request_id,
            endpoint,
            "count_tokens_websearch",
            stage_start,
            request_start,
        );

        return websearch::handle_websearch_request(provider, &payload, input_tokens).await;
    }

    // 转换请求
    let stage_start = Instant::now();
    let conversion_result = match convert_request(&payload) {
        Ok(result) => result,
        Err(e) => {
            let (error_type, message) = match &e {
                ConversionError::UnsupportedModel(model) => {
                    ("invalid_request_error", format!("模型不支持: {}", model))
                }
                ConversionError::EmptyMessages => {
                    ("invalid_request_error", "消息列表为空".to_string())
                }
            };
            tracing::warn!("请求转换失败: {}", e);
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse::new(error_type, message)),
            )
                .into_response();
        }
    };
    log_request_stage(
        &request_id,
        endpoint,
        "convert_request",
        stage_start,
        request_start,
    );

    // 构建 Kiro 请求
    let stage_start = Instant::now();
    let kiro_request = KiroRequest {
        conversation_state: conversion_result.conversation_state,
        profile_arn: state.profile_arn.clone(),
    };
    log_request_stage(
        &request_id,
        endpoint,
        "build_kiro_request",
        stage_start,
        request_start,
    );

    let stage_start = Instant::now();
    let request_body = match serde_json::to_string(&kiro_request) {
        Ok(body) => body,
        Err(e) => {
            tracing::error!("序列化请求失败: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse::new(
                    "internal_error",
                    format!("序列化请求失败: {}", e),
                )),
            )
                .into_response();
        }
    };
    log_request_stage(
        &request_id,
        endpoint,
        "serialize_kiro_request",
        stage_start,
        request_start,
    );

    tracing::debug!("Kiro request body: {}", request_body);

    // 估算最后一条消息的 tokens（非缓存部分）
    let stage_start = Instant::now();
    let last_msg_tokens = token::count_last_message_tokens(&payload.messages) as i32;
    log_request_stage(
        &request_id,
        endpoint,
        "count_last_message_tokens",
        stage_start,
        request_start,
    );

    // 估算输入 tokens（诊断：记录耗时）
    let t_count_start = std::time::Instant::now();
    let input_tokens = token::count_all_tokens(
        payload.model.clone(),
        payload.system,
        payload.messages,
        payload.tools,
    )
    .await as i32;
    let count_tokens_ms = t_count_start.elapsed().as_millis();
    if count_tokens_ms > 500 {
        tracing::warn!(
            request_id = %request_id,
            count_tokens_ms = count_tokens_ms,
            input_tokens = input_tokens,
            "count_all_tokens 耗时过长"
        );
    }
    log_request_stage(
        &request_id,
        endpoint,
        "count_all_tokens",
        t_count_start,
        request_start,
    );

    // 缓存命中 tokens = 总 input - 最后一条消息
    let stage_start = Instant::now();
    let cache_read_tokens = (input_tokens - last_msg_tokens).max(0);
    log_request_stage(
        &request_id,
        endpoint,
        "calculate_cache_tokens",
        stage_start,
        request_start,
    );

    // 检查是否启用了thinking
    let stage_start = Instant::now();
    let thinking_enabled = payload
        .thinking
        .as_ref()
        .map(|t| t.is_enabled())
        .unwrap_or(false);
    log_request_stage(
        &request_id,
        endpoint,
        "detect_thinking",
        stage_start,
        request_start,
    );

    // 提取用量追踪信息
    let stage_start = Instant::now();
    let api_key_id = identity.map(|ext| ext.0.id);
    let usage_tracker = state.usage_tracker.clone();
    log_request_stage(
        &request_id,
        endpoint,
        "prepare_usage_tracking",
        stage_start,
        request_start,
    );

    // 获取 Token 倍率
    let stage_start = Instant::now();
    let input_multiplier = provider.token_manager().get_input_multiplier();
    let output_multiplier = provider.token_manager().get_output_multiplier();
    log_request_stage(
        &request_id,
        endpoint,
        "load_token_multipliers",
        stage_start,
        request_start,
    );

    if payload.stream {
        handle_stream_request_buffered(
            provider,
            &request_body,
            &payload.model,
            input_tokens,
            cache_read_tokens,
            thinking_enabled,
            usage_tracker.clone(),
            api_key_id,
            input_multiplier,
            output_multiplier,
            request_id,
            endpoint,
            request_start,
        )
        .await
    } else {
        // 非流式响应（复用现有逻辑，已经使用正确的 input_tokens）
        handle_non_stream_request(
            provider,
            &request_body,
            &payload.model,
            input_tokens,
            cache_read_tokens,
            usage_tracker,
            api_key_id,
            input_multiplier,
            output_multiplier,
            request_id,
            endpoint,
            request_start,
        )
        .await
    }
}

/// 处理流式请求（延迟发送 message_start 版本）
///
/// 与 `handle_stream_request` 不同，此函数会延迟发送 message_start，
/// 等待 kiro 端返回 contextUsageEvent 后再发送，以获得准确的 input_tokens。
/// 收到 contextUsageEvent 后立即 flush 缓冲事件并切换为实时透传模式。
async fn handle_stream_request_buffered(
    provider: std::sync::Arc<crate::kiro::provider::KiroProvider>,
    request_body: &str,
    model: &str,
    estimated_input_tokens: i32,
    cache_read_tokens: i32,
    thinking_enabled: bool,
    usage_tracker: Option<std::sync::Arc<crate::model::usage::UsageTracker>>,
    api_key_id: Option<u32>,
    input_multiplier: f64,
    output_multiplier: f64,
    request_id: String,
    endpoint: &'static str,
    request_start: Instant,
) -> Response {
    // 调用 Kiro API（支持多凭据故障转移）
    let stage_start = Instant::now();
    let response = match provider.call_api_stream(request_body).await {
        Ok(resp) => resp,
        Err(e) => return map_provider_error(e),
    };
    log_request_stage(
        &request_id,
        endpoint,
        "provider_stream_response_headers",
        stage_start,
        request_start,
    );

    // 创建延迟流处理上下文
    let stage_start = Instant::now();
    let ctx = DelayedStreamContext::new(model, estimated_input_tokens, thinking_enabled)
        .with_cache_read_tokens(cache_read_tokens)
        .with_usage_tracking(usage_tracker, api_key_id)
        .with_multipliers(input_multiplier, output_multiplier);
    log_request_stage(
        &request_id,
        endpoint,
        "create_delayed_stream_context",
        stage_start,
        request_start,
    );

    // 创建延迟 SSE 流
    let stream =
        create_delayed_sse_stream(response, ctx, request_id.clone(), endpoint, request_start);
    log_request_stage(
        &request_id,
        endpoint,
        "response_ready_delayed_stream",
        request_start,
        request_start,
    );

    // 返回 SSE 响应
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, "keep-alive")
        .body(Body::from_stream(stream))
        .unwrap()
}

/// 创建延迟 SSE 事件流
///
/// 工作流程：
/// 1. Buffering 阶段：处理事件但不发送，等待 contextUsageEvent，期间只发 ping 保活
/// 2. 收到 contextUsageEvent 后：flush 所有缓冲事件（包含已更正 input_tokens 的 message_start）
/// 3. Streaming 阶段：后续事件实时透传
/// 4. 流结束：发送最终事件
fn create_delayed_sse_stream(
    response: reqwest::Response,
    ctx: DelayedStreamContext,
    request_id: String,
    endpoint: &'static str,
    request_start: Instant,
) -> impl Stream<Item = Result<Bytes, Infallible>> {
    let body_stream = response.bytes_stream();
    let stream_start = Instant::now();

    stream::unfold(
        (
            body_stream,
            ctx,
            EventStreamDecoder::new(),
            false,
            interval(Duration::from_secs(PING_INTERVAL_SECS)),
            request_id,
            endpoint,
            request_start,
            stream_start,
            false,
            false,
        ),
        |(
            mut body_stream,
            mut ctx,
            mut decoder,
            finished,
            mut ping_interval,
            request_id,
            endpoint,
            request_start,
            stream_start,
            mut first_upstream_chunk_logged,
            mut first_flush_logged,
        )| async move {
            if finished {
                return None;
            }

            // Buffering 阶段：循环读取直到切换为 Streaming 或流结束
            if !ctx.is_streaming() {
                loop {
                    tokio::select! {
                        biased;

                        // 优先 ping 保活
                        _ = ping_interval.tick() => {
                            tracing::trace!("发送 ping 保活事件（延迟模式 Buffering 阶段）");
                            let bytes: Vec<Result<Bytes, Infallible>> = vec![Ok(create_ping_sse())];
                            return Some((
                                stream::iter(bytes),
                                (
                                    body_stream,
                                    ctx,
                                    decoder,
                                    false,
                                    ping_interval,
                                    request_id,
                                    endpoint,
                                    request_start,
                                    stream_start,
                                    first_upstream_chunk_logged,
                                    first_flush_logged,
                                ),
                            ));
                        }

                        chunk_result = body_stream.next() => {
                            match chunk_result {
                                Some(Ok(chunk)) => {
                                    if !first_upstream_chunk_logged {
                                        log_request_stage(
                                            &request_id,
                                            endpoint,
                                            "stream_first_upstream_chunk",
                                            stream_start,
                                            request_start,
                                        );
                                        first_upstream_chunk_logged = true;
                                    }

                                    if let Err(e) = decoder.feed(&chunk) {
                                        tracing::warn!("缓冲区溢出: {}", e);
                                    }

                                    for result in decoder.decode_iter() {
                                        match result {
                                            Ok(frame) => {
                                                if let Ok(event) = Event::from_frame(frame) {
                                                    let sse_events = ctx.process_event(&event);
                                                    // 如果切换到了 Streaming 阶段，flush 缓冲事件
                                                    if ctx.is_streaming() && !sse_events.is_empty() {
                                                        let bytes: Vec<Result<Bytes, Infallible>> = sse_events
                                                            .into_iter()
                                                            .map(|e| Ok(Bytes::from(e.to_sse_string())))
                                                            .collect();
                                                        if !first_flush_logged {
                                                            log_request_stage(
                                                                &request_id,
                                                                endpoint,
                                                                "delayed_stream_first_flush",
                                                                stream_start,
                                                                request_start,
                                                            );
                                                            first_flush_logged = true;
                                                        }

                                                        return Some((
                                                            stream::iter(bytes),
                                                            (
                                                                body_stream,
                                                                ctx,
                                                                decoder,
                                                                false,
                                                                ping_interval,
                                                                request_id,
                                                                endpoint,
                                                                request_start,
                                                                stream_start,
                                                                first_upstream_chunk_logged,
                                                                first_flush_logged,
                                                            ),
                                                        ));
                                                    }
                                                }
                                            }
                                            Err(e) => {
                                                tracing::warn!("解码事件失败: {}", e);
                                            }
                                        }
                                    }
                                    // 继续读取下一个 chunk
                                }
                                Some(Err(e)) => {
                                    tracing::error!("读取响应流失败: {}", e);
                                    let all_events = ctx.finish();
                                    let bytes: Vec<Result<Bytes, Infallible>> = all_events
                                        .into_iter()
                                        .map(|e| Ok(Bytes::from(e.to_sse_string())))
                                        .collect();
                                    return Some((
                                        stream::iter(bytes),
                                        (
                                            body_stream,
                                            ctx,
                                            decoder,
                                            true,
                                            ping_interval,
                                            request_id,
                                            endpoint,
                                            request_start,
                                            stream_start,
                                            first_upstream_chunk_logged,
                                            first_flush_logged,
                                        ),
                                    ));
                                }
                                None => {
                                    // 流结束，使用估算值兜底
                                    let all_events = ctx.finish();
                                    let bytes: Vec<Result<Bytes, Infallible>> = all_events
                                        .into_iter()
                                        .map(|e| Ok(Bytes::from(e.to_sse_string())))
                                        .collect();
                                    return Some((
                                        stream::iter(bytes),
                                        (
                                            body_stream,
                                            ctx,
                                            decoder,
                                            true,
                                            ping_interval,
                                            request_id,
                                            endpoint,
                                            request_start,
                                            stream_start,
                                            first_upstream_chunk_logged,
                                            first_flush_logged,
                                        ),
                                    ));
                                }
                            }
                        }
                    }
                }
            }

            // Streaming 阶段：实时透传（与 create_sse_stream 逻辑一致）
            tokio::select! {
                chunk_result = body_stream.next() => {
                    match chunk_result {
                        Some(Ok(chunk)) => {
                            if !first_upstream_chunk_logged {
                                log_request_stage(
                                    &request_id,
                                    endpoint,
                                    "stream_first_upstream_chunk",
                                    stream_start,
                                    request_start,
                                );
                                first_upstream_chunk_logged = true;
                            }

                            if let Err(e) = decoder.feed(&chunk) {
                                tracing::warn!("缓冲区溢出: {}", e);
                            }

                            let mut events = Vec::new();
                            for result in decoder.decode_iter() {
                                match result {
                                    Ok(frame) => {
                                        if let Ok(event) = Event::from_frame(frame) {
                                            let sse_events = ctx.process_event(&event);
                                            events.extend(sse_events);
                                        }
                                    }
                                    Err(e) => {
                                        tracing::warn!("解码事件失败: {}", e);
                                    }
                                }
                            }

                            let bytes: Vec<Result<Bytes, Infallible>> = events
                                .into_iter()
                                .map(|e| Ok(Bytes::from(e.to_sse_string())))
                                .collect();

                            if !bytes.is_empty() && !first_flush_logged {
                                log_request_stage(
                                    &request_id,
                                    endpoint,
                                    "delayed_stream_first_flush",
                                    stream_start,
                                    request_start,
                                );
                                first_flush_logged = true;
                            }

                            Some((
                                stream::iter(bytes),
                                (
                                    body_stream,
                                    ctx,
                                    decoder,
                                    false,
                                    ping_interval,
                                    request_id,
                                    endpoint,
                                    request_start,
                                    stream_start,
                                    first_upstream_chunk_logged,
                                    first_flush_logged,
                                ),
                            ))
                        }
                        Some(Err(e)) => {
                            tracing::error!("读取响应流失败: {}", e);
                            let final_events = ctx.finish();
                            let bytes: Vec<Result<Bytes, Infallible>> = final_events
                                .into_iter()
                                .map(|e| Ok(Bytes::from(e.to_sse_string())))
                                .collect();
                            Some((
                                stream::iter(bytes),
                                (
                                    body_stream,
                                    ctx,
                                    decoder,
                                    true,
                                    ping_interval,
                                    request_id,
                                    endpoint,
                                    request_start,
                                    stream_start,
                                    first_upstream_chunk_logged,
                                    first_flush_logged,
                                ),
                            ))
                        }
                        None => {
                            // 流结束，发送最终事件
                            let final_events = ctx.finish();
                            let bytes: Vec<Result<Bytes, Infallible>> = final_events
                                .into_iter()
                                .map(|e| Ok(Bytes::from(e.to_sse_string())))
                                .collect();
                            Some((
                                stream::iter(bytes),
                                (
                                    body_stream,
                                    ctx,
                                    decoder,
                                    true,
                                    ping_interval,
                                    request_id,
                                    endpoint,
                                    request_start,
                                    stream_start,
                                    first_upstream_chunk_logged,
                                    first_flush_logged,
                                ),
                            ))
                        }
                    }
                }
                // ping 保活
                _ = ping_interval.tick() => {
                    tracing::trace!("发送 ping 保活事件（延迟模式 Streaming 阶段）");
                    let bytes: Vec<Result<Bytes, Infallible>> = vec![Ok(create_ping_sse())];
                    Some((
                        stream::iter(bytes),
                        (
                            body_stream,
                            ctx,
                            decoder,
                            false,
                            ping_interval,
                            request_id,
                            endpoint,
                            request_start,
                            stream_start,
                            first_upstream_chunk_logged,
                            first_flush_logged,
                        ),
                    ))
                }
            }
        },
    )
    .flatten()
}
