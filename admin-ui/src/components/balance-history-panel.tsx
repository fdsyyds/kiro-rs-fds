import { useState } from 'react'
import { RefreshCw, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useBalanceHistory } from '@/hooks/use-credentials'
import { useQueryClient } from '@tanstack/react-query'
import type { BalanceHistoryEntry } from '@/types/api'

// 格式化时间戳为可读时间
function formatTime(timestamp: number): string {
  const date = new Date(timestamp * 1000)
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

// 格式化数字为两位小数
function formatNumber(n: number): string {
  return n.toFixed(2)
}

export function BalanceHistoryPanel() {
  const { data: historyMap, isLoading, error } = useBalanceHistory()
  const queryClient = useQueryClient()
  // 记录每个凭据的展开状态，默认全部折叠
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ['balanceHistory'] })
  }

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const entries = Object.entries(historyMap || {})

  const expandAll = () => {
    setExpandedIds(new Set(entries.map(([id]) => id)))
  }

  const collapseAll = () => {
    setExpandedIds(new Set())
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        加载中...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-12 text-destructive">
        加载失败: {(error as Error).message}
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">用量监控</h2>
          <Button variant="outline" size="sm" onClick={handleRefresh}>
            <RefreshCw className="h-3 w-3 mr-1" />
            刷新
          </Button>
        </div>
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          暂无余额历史数据，服务启动后每分钟自动记录
        </div>
      </div>
    )
  }

  const allExpanded = expandedIds.size === entries.length

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-semibold">用量监控</h2>
          <Badge variant="secondary">{entries.length} 个凭据</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={allExpanded ? collapseAll : expandAll}>
            {allExpanded ? (
              <><ChevronsDownUp className="h-3 w-3 mr-1" />全部折叠</>
            ) : (
              <><ChevronsUpDown className="h-3 w-3 mr-1" />全部展开</>
            )}
          </Button>
          <Button variant="outline" size="sm" onClick={handleRefresh}>
            <RefreshCw className="h-3 w-3 mr-1" />
            刷新
          </Button>
        </div>
      </div>

      <div className="grid gap-4">
        {entries.map(([credentialId, records]: [string, BalanceHistoryEntry[]]) => {
          const latest = records[records.length - 1]
          const isExpanded = expandedIds.has(credentialId)
          return (
            <Card key={credentialId}>
              <CardHeader className="pb-3 cursor-pointer" onClick={() => toggleExpand(credentialId)}>
                <CardTitle className="flex items-center justify-between text-base">
                  <div className="flex items-center gap-2">
                    {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    <span>凭据 #{credentialId}</span>
                    {latest?.data.subscriptionTitle && (
                      <Badge variant="outline">{latest.data.subscriptionTitle}</Badge>
                    )}
                  </div>
                  {latest && (
                    <div className="flex items-center gap-3 text-sm font-normal text-muted-foreground">
                      <span className="text-xs text-muted-foreground">{formatTime(latest.recordedAt)}</span>
                      <span>
                        剩余: <span className="font-medium text-foreground">{formatNumber(latest.data.remaining)}</span>
                        {' / '}
                        {formatNumber(latest.data.usageLimit)}
                      </span>
                      <Badge
                        variant={latest.data.usagePercentage > 80 ? 'destructive' : latest.data.usagePercentage > 50 ? 'secondary' : 'default'}
                      >
                        {formatNumber(latest.data.usagePercentage)}%
                      </Badge>
                    </div>
                  )}
                </CardTitle>
              </CardHeader>
              {isExpanded && (
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-muted-foreground">
                          <th className="text-left py-2 pr-4 font-medium">时间</th>
                          <th className="text-right py-2 px-4 font-medium">已使用</th>
                          <th className="text-right py-2 px-4 font-medium">剩余</th>
                          <th className="text-right py-2 px-4 font-medium">总额度</th>
                          <th className="text-right py-2 pl-4 font-medium">使用率</th>
                        </tr>
                      </thead>
                      <tbody>
                        {records.map((record, index) => (
                          <tr key={index} className="border-b last:border-0">
                            <td className="py-2 pr-4 text-muted-foreground">{formatTime(record.recordedAt)}</td>
                            <td className="text-right py-2 px-4">{formatNumber(record.data.currentUsage)}</td>
                            <td className="text-right py-2 px-4 font-medium">{formatNumber(record.data.remaining)}</td>
                            <td className="text-right py-2 px-4">{formatNumber(record.data.usageLimit)}</td>
                            <td className="text-right py-2 pl-4">
                              <Badge
                                variant={record.data.usagePercentage > 80 ? 'destructive' : record.data.usagePercentage > 50 ? 'secondary' : 'outline'}
                                className="text-xs"
                              >
                                {formatNumber(record.data.usagePercentage)}%
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    共 {records.length} 条记录，每分钟自动更新，最多保留 10 条
                  </div>
                </CardContent>
              )}
            </Card>
          )
        })}
      </div>
    </div>
  )
}
