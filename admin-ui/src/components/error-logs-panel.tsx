import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { AlertTriangle, RefreshCw, Trash2, ChevronDown, ChevronRight, Copy } from 'lucide-react'
import { getErrorLogs, clearErrorLogs } from '@/api/credentials'
import type { ErrorLogEntry } from '@/api/credentials'

// 状态码对应的颜色
function getStatusBadgeVariant(code: number): 'destructive' | 'secondary' | 'default' {
  if (code >= 500) return 'destructive'
  if (code >= 400) return 'secondary'
  return 'default'
}

// 格式化时间
function formatTime(timestamp: string): string {
  const date = new Date(timestamp)
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

// 单条错误日志展开组件
function ErrorLogItem({ entry }: { entry: ErrorLogEntry }) {
  const [expanded, setExpanded] = useState(false)

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text)
    toast.success(`已复制${label}`)
  }

  return (
    <div className="border rounded-lg overflow-hidden">
      {/* 摘要行 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
      >
        {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        <Badge variant={getStatusBadgeVariant(entry.status_code)} className="shrink-0 text-xs">
          {entry.status_code}
        </Badge>
        <span className="text-xs text-muted-foreground shrink-0">{formatTime(entry.timestamp)}</span>
        <span className="text-xs font-mono truncate">{entry.endpoint}</span>
        {entry.model && <Badge variant="outline" className="text-xs shrink-0">{entry.model}</Badge>}
        <span className="text-xs text-muted-foreground truncate flex-1">{entry.error_message}</span>
      </button>

      {/* 展开详情 */}
      {expanded && (
        <div className="border-t px-4 py-3 space-y-3 bg-muted/30 text-sm">
          {/* 基础信息 */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="text-muted-foreground">请求 ID：</span>
              <span className="font-mono text-xs">{entry.request_id}</span>
            </div>
            <div>
              <span className="text-muted-foreground">错误类型：</span>
              <span className="font-mono text-xs">{entry.error_type}</span>
            </div>
            {entry.api_key_id !== null && (
              <div>
                <span className="text-muted-foreground">API Key ID：</span>
                <span>{entry.api_key_id === 0 ? '主密钥' : `#${entry.api_key_id}`}</span>
              </div>
            )}
            {entry.credential_id !== null && (
              <div>
                <span className="text-muted-foreground">凭据 ID：</span>
                <span>#{entry.credential_id}</span>
              </div>
            )}
          </div>

          {/* 错误消息 */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-muted-foreground text-xs font-medium">错误消息</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2"
                onClick={() => copyToClipboard(entry.error_message, '错误消息')}
              >
                <Copy className="h-3 w-3" />
              </Button>
            </div>
            <pre className="bg-background border rounded p-2 text-xs whitespace-pre-wrap break-all max-h-32 overflow-auto">
              {entry.error_message}
            </pre>
          </div>

          {/* 上游响应 */}
          {entry.upstream_response && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-muted-foreground text-xs font-medium">上游响应</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2"
                  onClick={() => copyToClipboard(entry.upstream_response!, '上游响应')}
                >
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
              <pre className="bg-background border rounded p-2 text-xs whitespace-pre-wrap break-all max-h-40 overflow-auto">
                {entry.upstream_response}
              </pre>
            </div>
          )}

          {/* 请求体 */}
          {entry.request_body && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-muted-foreground text-xs font-medium">请求体</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2"
                  onClick={() => copyToClipboard(entry.request_body!, '请求体')}
                >
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
              <pre className="bg-background border rounded p-2 text-xs whitespace-pre-wrap break-all max-h-48 overflow-auto">
                {entry.request_body}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// 主面板组件
export function ErrorLogsPanel() {
  const queryClient = useQueryClient()
  const [statusFilter, setStatusFilter] = useState<string>('all')

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['error-logs'],
    queryFn: getErrorLogs,
    refetchInterval: 10000, // 每10秒自动刷新
  })

  const { mutate: handleClear, isPending: isClearing } = useMutation({
    mutationFn: clearErrorLogs,
    onSuccess: () => {
      toast.success('错误日志已清空')
      queryClient.invalidateQueries({ queryKey: ['error-logs'] })
    },
    onError: () => toast.error('清空失败'),
  })

  const logs = data?.logs || []

  // 按状态码筛选
  const filteredLogs = statusFilter === 'all'
    ? logs
    : logs.filter(log => {
        if (statusFilter === '4xx') return log.status_code >= 400 && log.status_code < 500
        if (statusFilter === '5xx') return log.status_code >= 500
        return true
      })

  // 统计
  const count4xx = logs.filter(l => l.status_code >= 400 && l.status_code < 500).length
  const count5xx = logs.filter(l => l.status_code >= 500).length

  return (
    <div className="space-y-4">
      {/* 顶部统计 */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">总错误数</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data?.total ?? 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">4xx 客户端错误</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">{count4xx}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">5xx 服务端错误</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{count5xx}</div>
          </CardContent>
        </Card>
      </div>

      {/* 操作栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">错误日志</h2>
          <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5 ml-2">
            {([
              { key: 'all', label: '全部', count: logs.length },
              { key: '4xx', label: '4xx', count: count4xx },
              { key: '5xx', label: '5xx', count: count5xx },
            ] as const).map(({ key, label, count }) => (
              <button
                key={key}
                onClick={() => setStatusFilter(key)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                  statusFilter === key
                    ? 'bg-background shadow-sm text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {label}
                {count > 0 && <span className="ml-1 text-[10px] opacity-60">{count}</span>}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isLoading}
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${isLoading ? 'animate-spin' : ''}`} />
            刷新
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleClear()}
            disabled={isClearing || logs.length === 0}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="h-4 w-4 mr-1" />
            清空
          </Button>
        </div>
      </div>

      {/* 日志列表 */}
      {isLoading ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            加载中...
          </CardContent>
        </Card>
      ) : filteredLogs.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            {logs.length === 0 ? '暂无错误日志' : '没有匹配的错误日志'}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-1">
          {filteredLogs.map((entry, index) => (
            <ErrorLogItem key={`${entry.request_id}-${index}`} entry={entry} />
          ))}
        </div>
      )}
    </div>
  )
}
