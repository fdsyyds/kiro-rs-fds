import axios from 'axios'
import { storage } from '@/lib/storage'
import type {
  CredentialsStatusResponse,
  BalanceResponse,
  SuccessResponse,
  SetDisabledRequest,
  SetPriorityRequest,
  AddCredentialRequest,
  AddCredentialResponse,
  UpdateCredentialRequest,
  ApiKeyItem,
  CreateApiKeyRequest,
  UpdateApiKeyRequest,
  UsageSummary,
  RpmSnapshot,
  BalanceHistoryMap,
} from '@/types/api'

// 创建 axios 实例
const api = axios.create({
  baseURL: '/api/admin',
  headers: {
    'Content-Type': 'application/json',
  },
})

// 请求拦截器添加 API Key
api.interceptors.request.use((config) => {
  const apiKey = storage.getApiKey()
  if (apiKey) {
    config.headers['x-api-key'] = apiKey
  }
  return config
})

// 获取所有凭据状态
export async function getCredentials(): Promise<CredentialsStatusResponse> {
  const { data } = await api.get<CredentialsStatusResponse>('/credentials')
  return data
}

// 设置凭据禁用状态
export async function setCredentialDisabled(
  id: number,
  disabled: boolean
): Promise<SuccessResponse> {
  const { data } = await api.post<SuccessResponse>(
    `/credentials/${id}/disabled`,
    { disabled } as SetDisabledRequest
  )
  return data
}

// 设置凭据优先级
export async function setCredentialPriority(
  id: number,
  priority: number
): Promise<SuccessResponse> {
  const { data } = await api.post<SuccessResponse>(
    `/credentials/${id}/priority`,
    { priority } as SetPriorityRequest
  )
  return data
}

// 重置失败计数
export async function resetCredentialFailure(
  id: number
): Promise<SuccessResponse> {
  const { data } = await api.post<SuccessResponse>(`/credentials/${id}/reset`)
  return data
}

// 获取凭据余额
export async function getCredentialBalance(id: number): Promise<BalanceResponse> {
  const { data } = await api.get<BalanceResponse>(`/credentials/${id}/balance`)
  return data
}

// 添加新凭据
export async function addCredential(
  req: AddCredentialRequest
): Promise<AddCredentialResponse> {
  const { data } = await api.post<AddCredentialResponse>('/credentials', req)
  return data
}

// 删除凭据
export async function deleteCredential(id: number): Promise<SuccessResponse> {
  const { data } = await api.delete<SuccessResponse>(`/credentials/${id}`)
  return data
}

// 删除全部凭据
export async function deleteAllCredentials(): Promise<SuccessResponse> {
  const { data } = await api.delete<SuccessResponse>('/credentials')
  return data
}

// 更新凭据
export async function updateCredential(id: number, req: UpdateCredentialRequest): Promise<SuccessResponse> {
  const { data } = await api.put<SuccessResponse>(`/credentials/${id}`, req)
  return data
}

// 导出凭据（包含敏感字段，和导入格式一致）
export async function exportCredentials(ids: number[]): Promise<unknown[]> {
  const { data } = await api.post<unknown[]>('/credentials/export', { ids })
  return data
}

// 获取负载均衡模式
export async function getLoadBalancingMode(): Promise<{ mode: 'priority' | 'balanced' }> {
  const { data } = await api.get<{ mode: 'priority' | 'balanced' }>('/config/load-balancing')
  return data
}

// 设置负载均衡模式
export async function setLoadBalancingMode(mode: 'priority' | 'balanced'): Promise<{ mode: 'priority' | 'balanced' }> {
  const { data } = await api.put<{ mode: 'priority' | 'balanced' }>('/config/load-balancing', { mode })
  return data
}

// 获取 Token 倍率
export async function getMultipliers(): Promise<{ inputMultiplier: number; outputMultiplier: number }> {
  const { data } = await api.get<{ inputMultiplier: number; outputMultiplier: number }>('/config/multipliers')
  return data
}

// 设置 Token 倍率
export async function setMultipliers(inputMultiplier: number, outputMultiplier: number): Promise<{ inputMultiplier: number; outputMultiplier: number }> {
  const { data } = await api.put<{ inputMultiplier: number; outputMultiplier: number }>('/config/multipliers', { inputMultiplier, outputMultiplier })
  return data
}

// ============ 服务器信息 ============

// 获取服务器连接信息
export async function getServerInfo(): Promise<{ masterApiKey: string | null }> {
  const { data } = await api.get<{ masterApiKey: string | null }>('/server-info')
  return data
}

// ============ API Key 管理 ============

// 获取所有 API Key
export async function getApiKeys(): Promise<ApiKeyItem[]> {
  const { data } = await api.get<ApiKeyItem[]>('/api-keys')
  return data
}

// 创建 API Key
export async function createApiKey(req: CreateApiKeyRequest): Promise<ApiKeyItem> {
  const { data } = await api.post<ApiKeyItem>('/api-keys', req)
  return data
}

// 更新 API Key
export async function updateApiKey(id: number, req: UpdateApiKeyRequest): Promise<ApiKeyItem> {
  const { data } = await api.put<ApiKeyItem>(`/api-keys/${id}`, req)
  return data
}

// 删除 API Key
export async function deleteApiKey(id: number): Promise<SuccessResponse> {
  const { data } = await api.delete<SuccessResponse>(`/api-keys/${id}`)
  return data
}

// ============ API Key 用量 ============

// 获取所有 API Key 用量概览
export async function getAllUsage(): Promise<UsageSummary[]> {
  const { data } = await api.get<UsageSummary[]>('/api-keys/usage')
  return data
}

// 获取单个 API Key 用量
export async function getKeyUsage(id: number): Promise<UsageSummary> {
  const { data } = await api.get<UsageSummary>(`/api-keys/${id}/usage`)
  return data
}

// 重置单个 API Key 用量
export async function resetKeyUsage(id: number): Promise<SuccessResponse> {
  const { data } = await api.delete<SuccessResponse>(`/api-keys/${id}/usage`)
  return data
}

// ============ RPM 监控 ============

// 获取实时 RPM 数据
export async function getRpm(): Promise<RpmSnapshot> {
  const { data } = await api.get<RpmSnapshot>('/rpm')
  return data
}

// ============ 余额历史 ============

// 获取所有凭据的余额历史
export async function getBalanceHistory(): Promise<BalanceHistoryMap> {
  const { data } = await api.get<BalanceHistoryMap>('/credentials/balance-history')
  return data
}

// ============ 池状态 & 冷却配置 ============

export interface PoolIdleEntry {
  id: number
  email: string | null
  priority: number
  successCount: number
}

export interface PoolBusyEntry {
  id: number
  email: string | null
  priority: number
  cooldownUntil: string
  remainingSeconds: number
}

export interface PoolStatusResponse {
  idle: PoolIdleEntry[]
  busy: PoolBusyEntry[]
  cooldownSeconds: number
}

// 获取池状态
export async function getPoolStatus(): Promise<PoolStatusResponse> {
  const { data } = await api.get<PoolStatusResponse>('/pool-status')
  return data
}

// 获取 429 冷却时长
export async function getCooldown(): Promise<{ cooldownSeconds: number }> {
  const { data } = await api.get<{ cooldownSeconds: number }>('/config/cooldown')
  return data
}

// 设置 429 冷却时长
export async function setCooldown(cooldownSeconds: number): Promise<SuccessResponse> {
  const { data } = await api.put<SuccessResponse>('/config/cooldown', { cooldownSeconds })
  return data
}

// 获取余额监控开关状态
export async function getBalanceMonitoring(): Promise<{ enabled: boolean }> {
  const { data } = await api.get<{ enabled: boolean }>('/config/balance-monitoring')
  return data
}

// 设置余额监控开关
export async function setBalanceMonitoring(enabled: boolean): Promise<SuccessResponse> {
  const { data } = await api.put<SuccessResponse>('/config/balance-monitoring', { enabled })
  return data
}

// ============ 错误日志 ============

export interface ErrorLogEntry {
  request_id: string
  timestamp: string
  endpoint: string
  model: string | null
  credential_id: number | null
  api_key_id: number | null
  client_ip: string | null
  error_type: string
  error_message: string
  status_code: number
  upstream_response: string | null
  request_body: string | null
}

export interface ErrorLogsResponse {
  total: number
  logs: ErrorLogEntry[]
}

// 获取错误日志
export async function getErrorLogs(): Promise<ErrorLogsResponse> {
  const { data } = await api.get<ErrorLogsResponse>('/error-logs')
  return data
}

// 清空错误日志
export async function clearErrorLogs(): Promise<SuccessResponse> {
  const { data } = await api.delete<SuccessResponse>('/error-logs')
  return data
}
