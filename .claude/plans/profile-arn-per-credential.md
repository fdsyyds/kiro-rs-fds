# 方案：每个凭据使用自己的 profileArn

## 问题

当前 `profileArn` 在 handler 层写死（来自 `AppState.profile_arn`，启动时从第一个凭据获取），而 provider 内部会根据负载均衡/故障转移选择不同的凭据。这导致：
- 如果第一个凭据没有 `profileArn`，所有请求都不带
- 不同凭据可能有不同的 `profileArn`，但请求里只会带第一个的

## 方案

**在 provider 内部发送请求前，动态注入当前凭据的 `profileArn` 到请求体中。**

### 具体改动

1. **`src/kiro/provider.rs`** — 添加辅助方法 `inject_profile_arn`：
   - 解析请求体 JSON
   - 替换/设置 `profileArn` 为当前凭据的值
   - 重新序列化
   - 在 `call_api_with_retry` 和 `call_mcp_with_retry` 的循环内，选好凭据后调用此方法

2. **`src/anthropic/handlers.rs`** — 不再传入固定的 `profile_arn`：
   - 构建 `KiroRequest` 时 `profile_arn` 设为 `None`（因为 provider 会动态注入）
   - 两处（约第 547 行和第 1477 行）

3. **`src/anthropic/middleware.rs`** — `AppState.profile_arn` 字段可以保留（向后兼容），但不再影响实际请求

4. **`src/main.rs`** — 启动时传入 `profile_arn` 的逻辑可以移除或保留为 fallback（可选）

### 关键点

- `inject_profile_arn` 在每次循环迭代中执行（故障转移时凭据会变），性能开销很小（一次 JSON parse + serialize）
- 如果凭据没有 `profile_arn`，则从请求体中移除该字段（保持原有行为）
- MCP 请求体结构不同，需要确认是否也需要 `profileArn`

### 修改文件清单

| 文件 | 改动 |
|------|------|
| `src/kiro/provider.rs` | 添加 `inject_profile_arn` 方法，在两处循环体内调用 |
| `src/anthropic/handlers.rs` | 两处 `profile_arn: state.profile_arn.clone()` → `profile_arn: None` |
