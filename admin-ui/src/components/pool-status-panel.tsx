import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Zap, Circle, RefreshCw, Save } from 'lucide-react'
import { getPoolStatus, getCooldown, setCooldown } from '@/api/credentials'
import type { PoolStatusResponse } from '@/api/credentials'

export function PoolStatusPanel() {
  const queryClient = useQueryClient()
  const [cooldownInput, setCooldownInput] = useState('')
  const [isEditing, setIsEditing] = useState(false)

  const { data: poolData, isLoading } = useQuery<PoolStatusResponse>({
    queryKey: ['pool-status'],
    queryFn: getPoolStatus,
    refetchInterval: 5000,
  })

  const { data: cooldownData } = useQuery({
    queryKey: ['cooldown'],
    queryFn: getCooldown,
  })

  useEffect(() => {
    if (cooldownData && !isEditing) {
      setCooldownInput(String(cooldownData.cooldownSeconds))
    }
  }, [cooldownData, isEditing])

  const { mutate: saveCooldown, isPending } = useMutation({
    mutationFn: (seconds: number) => setCooldown(seconds),
    onSuccess: () => {
      toast.success('冷却时长已更新')
      setIsEditing(false)
      queryClient.invalidateQueries({ queryKey: ['cooldown'] })
    },
    onError: () => toast.error('更新失败'),
  })

  const idleCount = poolData?.idle.length ?? 0
  const busyCount = poolData?.busy.length ?? 0

  return (
    <div className="space-y-6">
      {/* 顶部统计卡片 */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Idle</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{idleCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Busy (429 冷却)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-orange-500">{busyCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">冷却时长</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                value={cooldownInput}
                onChange={(e) => { setCooldownInput(e.target.value); setIsEditing(true) }}
                className="w-24 h-8 text-sm"
              />
              <span className="text-sm text-muted-foreground">秒</span>
              {isEditing && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  disabled={isPending}
                  onClick={() => {
                    const val = parseInt(cooldownInput)
                    if (val > 0) saveCooldown(val)
                    else toast.error('冷却时长必须大于 0')
                  }}
                >
                  <Save className="h-3 w-3 mr-1" />
                  保存
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 池列表 */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Idle Pool */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Circle className="h-4 w-4 text-green-500 fill-green-500" />
                Idle Pool
              </CardTitle>
              <Badge variant="secondary">{idleCount}</Badge>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <RefreshCw className="h-4 w-4 animate-spin mr-2" />
                加载中...
              </div>
            ) : idleCount === 0 ? (
              <p className="text-sm text-muted-foreground py-4">无可用凭据</p>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {poolData!.idle.map((entry) => (
                  <div key={entry.id} className="flex items-center justify-between py-2 px-3 rounded-md bg-muted/50">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">#{entry.id}</span>
                      <span className="text-sm font-medium truncate max-w-[180px]">
                        {entry.email || '未知'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">P{entry.priority}</Badge>
                      <span className="text-xs text-muted-foreground">{entry.successCount} req</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Busy Pool */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Zap className="h-4 w-4 text-orange-500" />
                Busy Pool (429 冷却)
              </CardTitle>
              <Badge variant="secondary">{busyCount}</Badge>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <RefreshCw className="h-4 w-4 animate-spin mr-2" />
                加载中...
              </div>
            ) : busyCount === 0 ? (
              <p className="text-sm text-muted-foreground py-4">无冷却中凭据</p>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {poolData!.busy.map((entry) => (
                  <div key={entry.id} className="flex items-center justify-between py-2 px-3 rounded-md bg-orange-50 dark:bg-orange-950/20">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">#{entry.id}</span>
                      <span className="text-sm font-medium truncate max-w-[180px]">
                        {entry.email || '未知'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">P{entry.priority}</Badge>
                      <Badge variant="destructive" className="text-xs">
                        {entry.remainingSeconds}s
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground text-center">每 5 秒自动刷新</p>
    </div>
  )
}
