import { useState, useEffect, useRef } from 'react'
import { RefreshCw, LogOut, Moon, Sun, Server, Plus, Upload, FileUp, Download, Trash2, RotateCcw, CheckCircle2, Key, BarChart3, Zap, Search, X } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { storage } from '@/lib/storage'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { CredentialCard } from '@/components/credential-card'
import { BalanceDialog } from '@/components/balance-dialog'
import { AddCredentialDialog } from '@/components/add-credential-dialog'
import { BatchImportDialog } from '@/components/batch-import-dialog'
import { KamImportDialog } from '@/components/kam-import-dialog'
import { BatchVerifyDialog, type VerifyResult } from '@/components/batch-verify-dialog'
import { ApiKeysPanel } from '@/components/api-keys-panel'
import { BalanceHistoryPanel } from '@/components/balance-history-panel'
import { PoolStatusPanel } from '@/components/pool-status-panel'
import { useCredentials, useDeleteCredential, useDeleteAllCredentials, useResetFailure, useLoadBalancingMode, useSetLoadBalancingMode, useRpm, useMultipliers, useSetMultipliers } from '@/hooks/use-credentials'
import { getCredentialBalance, exportCredentials } from '@/api/credentials'
import { extractErrorMessage } from '@/lib/utils'
import type { BalanceResponse } from '@/types/api'

interface DashboardProps {
  onLogout: () => void
}

export function Dashboard({ onLogout }: DashboardProps) {
  const [activeTab, setActiveTab] = useState<'credentials' | 'apikeys' | 'balance-history' | 'pool-status'>('credentials')
  const [selectedCredentialId, setSelectedCredentialId] = useState<number | null>(null)
  const [balanceDialogOpen, setBalanceDialogOpen] = useState(false)
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [batchImportDialogOpen, setBatchImportDialogOpen] = useState(false)
  const [kamImportDialogOpen, setKamImportDialogOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [credentialSearch, setCredentialSearch] = useState('')
  const [verifyDialogOpen, setVerifyDialogOpen] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [verifyProgress, setVerifyProgress] = useState({ current: 0, total: 0 })
  const [verifyResults, setVerifyResults] = useState<Map<number, VerifyResult>>(new Map())
  const [balanceMap, setBalanceMap] = useState<Map<number, BalanceResponse>>(new Map())
  const [loadingBalanceIds, setLoadingBalanceIds] = useState<Set<number>>(new Set())
  const [queryingInfo, setQueryingInfo] = useState(false)
  const [queryInfoProgress, setQueryInfoProgress] = useState({ current: 0, total: 0 })
  const cancelVerifyRef = useRef(false)
  const [currentPage, setCurrentPage] = useState(1)
  const itemsPerPage = 30
  const [darkMode, setDarkMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return document.documentElement.classList.contains('dark')
    }
    return false
  })

  const queryClient = useQueryClient()
  const { data, isLoading, error, refetch } = useCredentials()
  const { data: rpmData } = useRpm()
  const { mutate: deleteCredential } = useDeleteCredential()
  const { mutate: deleteAllCredentials, isPending: isDeletingAllCredentials } = useDeleteAllCredentials()
  const { mutate: resetFailure } = useResetFailure()
  const { data: loadBalancingData, isLoading: isLoadingMode } = useLoadBalancingMode()
  const { mutate: setLoadBalancingMode, isPending: isSettingMode } = useSetLoadBalancingMode()
  const { data: multipliersData } = useMultipliers()
  const { mutate: setMultipliers, isPending: isSettingMultiplier } = useSetMultipliers()
  const [inputMultiplierInput, setInputMultiplierInput] = useState('')
  const [outputMultiplierInput, setOutputMultiplierInput] = useState('')
  const [isEditingMultiplier, setIsEditingMultiplier] = useState(false)

  // 筛选 + 分页
  const searchQuery = credentialSearch.trim().toLowerCase()
  const filteredCredentials = (data?.credentials || []).filter(c => {
    let matchesStatus = true
    if (statusFilter === 'active') matchesStatus = !c.disabled && c.failureCount === 0
    if (statusFilter === 'disabled') matchesStatus = c.disabled
    if (statusFilter === 'failed') matchesStatus = c.failureCount > 0 && !c.disabled
    if (statusFilter.startsWith('tier:')) {
      const tier = statusFilter.slice(5).toLowerCase()
      matchesStatus = c.subscriptionTitle?.toLowerCase().includes(tier) || false
    }
    if (!matchesStatus) return false
    if (!searchQuery) return true

    const searchableText = [
      c.id,
      `#${c.id}`,
      c.email,
      c.subscriptionTitle,
      c.authMethod,
      c.refreshTokenHash,
      c.proxyUrl,
      c.clientId,
      c.priority,
      c.rpmLimit,
      c.successCount,
      c.lastUsedAt,
    ]
      .filter(value => value !== null && value !== undefined)
      .join(' ')
      .toLowerCase()

    return searchableText.includes(searchQuery)
  })
  const totalPages = Math.ceil(filteredCredentials.length / itemsPerPage)
  const startIndex = (currentPage - 1) * itemsPerPage
  const endIndex = startIndex + itemsPerPage
  const currentCredentials = filteredCredentials.slice(startIndex, endIndex)
  const disabledCredentialCount = data?.credentials.filter(credential => credential.disabled).length || 0
  const failedCredentialCount = data?.credentials.filter(c => c.failureCount > 0 && !c.disabled).length || 0

  // 订阅等级统计
  const tierCounts = (data?.credentials || []).reduce<Record<string, number>>((acc, c) => {
    const tier = c.subscriptionTitle || '未知'
    acc[tier] = (acc[tier] || 0) + 1
    return acc
  }, {})
  // 筛选或凭据列表变化时重置到第一页
  useEffect(() => {
    setCurrentPage(1)
  }, [data?.credentials.length, statusFilter, searchQuery])

  // 只保留当前仍存在的凭据缓存，避免删除后残留旧数据
  useEffect(() => {
    if (!data?.credentials) {
      setBalanceMap(new Map())
      setLoadingBalanceIds(new Set())
      return
    }

    const validIds = new Set(data.credentials.map(credential => credential.id))

    setBalanceMap(prev => {
      const next = new Map<number, BalanceResponse>()
      prev.forEach((value, id) => {
        if (validIds.has(id)) {
          next.set(id, value)
        }
      })
      return next.size === prev.size ? prev : next
    })

    setLoadingBalanceIds(prev => {
      if (prev.size === 0) {
        return prev
      }
      const next = new Set<number>()
      prev.forEach(id => {
        if (validIds.has(id)) {
          next.add(id)
        }
      })
      return next.size === prev.size ? prev : next
    })
  }, [data?.credentials])

  const toggleDarkMode = () => {
    setDarkMode(!darkMode)
    document.documentElement.classList.toggle('dark')
  }

  const handleViewBalance = (id: number) => {
    setSelectedCredentialId(id)
    setBalanceDialogOpen(true)
  }

  const handleRefresh = () => {
    refetch()
    toast.success('已刷新凭据列表')
  }

  const handleLogout = () => {
    storage.removeApiKey()
    queryClient.clear()
    onLogout()
  }

  // 选择管理
  const toggleSelect = (id: number) => {
    const newSelected = new Set(selectedIds)
    if (newSelected.has(id)) {
      newSelected.delete(id)
    } else {
      newSelected.add(id)
    }
    setSelectedIds(newSelected)
  }

  const deselectAll = () => {
    setSelectedIds(new Set())
  }

  // 批量删除选中凭据
  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) {
      toast.error('请先选择要删除的凭据')
      return
    }

    const ids = Array.from(selectedIds)

    if (!confirm(`确定要删除选中的 ${ids.length} 个凭据吗？此操作无法撤销。`)) {
      return
    }

    let successCount = 0
    let failCount = 0

    for (const id of ids) {
      try {
        await new Promise<void>((resolve, reject) => {
          deleteCredential(id, {
            onSuccess: () => {
              successCount++
              resolve()
            },
            onError: (err) => {
              failCount++
              reject(err)
            }
          })
        })
      } catch (error) {
        // 错误已在 onError 中处理
      }
    }

    if (failCount === 0) {
      toast.success(`成功删除 ${successCount} 个凭据`)
    } else {
      toast.warning(`删除凭据：成功 ${successCount} 个，失败 ${failCount} 个`)
    }

    deselectAll()
  }

  // 批量恢复异常
  const handleBatchResetFailure = async () => {
    if (selectedIds.size === 0) {
      toast.error('请先选择要恢复的凭据')
      return
    }

    const failedIds = Array.from(selectedIds).filter(id => {
      const cred = data?.credentials.find(c => c.id === id)
      return cred && cred.failureCount > 0
    })

    if (failedIds.length === 0) {
      toast.error('选中的凭据中没有失败的凭据')
      return
    }

    let successCount = 0
    let failCount = 0

    for (const id of failedIds) {
      try {
        await new Promise<void>((resolve, reject) => {
          resetFailure(id, {
            onSuccess: () => {
              successCount++
              resolve()
            },
            onError: (err) => {
              failCount++
              reject(err)
            }
          })
        })
      } catch (error) {
        // 错误已在 onError 中处理
      }
    }

    if (failCount === 0) {
      toast.success(`成功恢复 ${successCount} 个凭据`)
    } else {
      toast.warning(`成功 ${successCount} 个，失败 ${failCount} 个`)
    }

    deselectAll()
  }

  // 一键清除所有已禁用凭据
  const handleClearAll = async () => {
    if (!data?.credentials || data.credentials.length === 0) {
      toast.error('没有可清除的凭据')
      return
    }

    const disabledCredentials = data.credentials.filter(credential => credential.disabled)

    if (disabledCredentials.length === 0) {
      toast.error('没有可清除的已禁用凭据')
      return
    }

    if (!confirm(`确定要清除所有 ${disabledCredentials.length} 个已禁用凭据吗？此操作无法撤销。`)) {
      return
    }

    let successCount = 0
    let failCount = 0

    for (const credential of disabledCredentials) {
      try {
        await new Promise<void>((resolve, reject) => {
          deleteCredential(credential.id, {
            onSuccess: () => {
              successCount++
              resolve()
            },
            onError: (err) => {
              failCount++
              reject(err)
            }
          })
        })
      } catch (error) {
        // 错误已在 onError 中处理
      }
    }

    if (failCount === 0) {
      toast.success(`成功清除所有 ${successCount} 个已禁用凭据`)
    } else {
      toast.warning(`清除已禁用凭据：成功 ${successCount} 个，失败 ${failCount} 个`)
    }

    deselectAll()
  }

  // 删除全部凭据
  const handleDeleteAllCredentials = () => {
    const total = data?.credentials.length || 0
    if (total === 0) {
      toast.error('没有可删除的凭据')
      return
    }

    if (!confirm(`确定要删除全部 ${total} 个凭据吗？此操作无法撤销。`)) {
      return
    }

    if (!confirm('再次确认：这会删除所有凭据，包括正常启用的凭据。是否继续？')) {
      return
    }

    deleteAllCredentials(undefined, {
      onSuccess: (res) => {
        toast.success(res.message)
        deselectAll()
        setBalanceMap(new Map())
        setLoadingBalanceIds(new Set())
      },
      onError: (error) => {
        toast.error('删除全部凭据失败: ' + extractErrorMessage(error))
      }
    })
  }

  // 导出凭据
  const handleExportCredentials = async (exportAll: boolean) => {
    const ids = exportAll ? [] : Array.from(selectedIds)
    if (!exportAll && ids.length === 0) {
      toast.error('请先选择要导出的凭据')
      return
    }

    try {
      const credentials = await exportCredentials(ids)
      const json = JSON.stringify(credentials, null, 2)
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `credentials-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      toast.success(`已导出 ${credentials.length} 个凭据`)
    } catch (error) {
      toast.error('导出失败: ' + extractErrorMessage(error))
    }
  }

  // 查询当前页凭据信息（逐个查询，避免瞬时并发）
  const handleQueryCurrentPageInfo = async () => {
    if (currentCredentials.length === 0) {
      toast.error('当前页没有可查询的凭据')
      return
    }

    const ids = currentCredentials
      .filter(credential => !credential.disabled)
      .map(credential => credential.id)

    if (ids.length === 0) {
      toast.error('当前页没有可查询的启用凭据')
      return
    }

    setQueryingInfo(true)
    setQueryInfoProgress({ current: 0, total: ids.length })

    let successCount = 0
    let failCount = 0

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]

      setLoadingBalanceIds(prev => {
        const next = new Set(prev)
        next.add(id)
        return next
      })

      try {
        const balance = await getCredentialBalance(id)
        successCount++

        setBalanceMap(prev => {
          const next = new Map(prev)
          next.set(id, balance)
          return next
        })
      } catch (error) {
        failCount++
      } finally {
        setLoadingBalanceIds(prev => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }

      setQueryInfoProgress({ current: i + 1, total: ids.length })
    }

    setQueryingInfo(false)

    if (failCount === 0) {
      toast.success(`查询完成：成功 ${successCount}/${ids.length}`)
    } else {
      toast.warning(`查询完成：成功 ${successCount} 个，失败 ${failCount} 个`)
    }
  }

  // 批量验活
  const handleBatchVerify = async () => {
    if (selectedIds.size === 0) {
      toast.error('请先选择要验活的凭据')
      return
    }

    // 初始化状态
    setVerifying(true)
    cancelVerifyRef.current = false
    const ids = Array.from(selectedIds)
    setVerifyProgress({ current: 0, total: ids.length })

    let successCount = 0

    // 初始化结果，所有凭据状态为 pending
    const initialResults = new Map<number, VerifyResult>()
    ids.forEach(id => {
      initialResults.set(id, { id, status: 'pending' })
    })
    setVerifyResults(initialResults)
    setVerifyDialogOpen(true)

    // 开始验活
    for (let i = 0; i < ids.length; i++) {
      // 检查是否取消
      if (cancelVerifyRef.current) {
        toast.info('已取消验活')
        break
      }

      const id = ids[i]

      // 更新当前凭据状态为 verifying
      setVerifyResults(prev => {
        const newResults = new Map(prev)
        newResults.set(id, { id, status: 'verifying' })
        return newResults
      })

      try {
        const balance = await getCredentialBalance(id)
        successCount++

        // 更新为成功状态
        setVerifyResults(prev => {
          const newResults = new Map(prev)
          newResults.set(id, {
            id,
            status: 'success',
            usage: `${balance.currentUsage}/${balance.usageLimit}`
          })
          return newResults
        })
      } catch (error) {
        // 更新为失败状态
        setVerifyResults(prev => {
          const newResults = new Map(prev)
          newResults.set(id, {
            id,
            status: 'failed',
            error: extractErrorMessage(error)
          })
          return newResults
        })
      }

      // 更新进度
      setVerifyProgress({ current: i + 1, total: ids.length })

      // 添加延迟防止封号（最后一个不需要延迟）
      if (i < ids.length - 1 && !cancelVerifyRef.current) {
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }

    setVerifying(false)

    if (!cancelVerifyRef.current) {
      toast.success(`验活完成：成功 ${successCount}/${ids.length}`)
    }
  }

  // 取消验活
  const handleCancelVerify = () => {
    cancelVerifyRef.current = true
    setVerifying(false)
  }

  // 切换负载均衡模式
  const handleToggleLoadBalancing = () => {
    const currentMode = loadBalancingData?.mode || 'priority'
    const newMode = currentMode === 'priority' ? 'balanced' : 'priority'

    setLoadBalancingMode(newMode, {
      onSuccess: () => {
        const modeName = newMode === 'priority' ? '优先级模式' : '均衡负载模式'
        toast.success(`已切换到${modeName}`)
      },
      onError: (error) => {
        toast.error(`切换失败: ${extractErrorMessage(error)}`)
      }
    })
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">加载中...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <div className="text-red-500 mb-4">加载失败</div>
            <p className="text-muted-foreground mb-4">{(error as Error).message}</p>
            <div className="space-x-2">
              <Button onClick={() => refetch()}>重试</Button>
              <Button variant="outline" onClick={handleLogout}>重新登录</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      {/* 顶部导航 */}
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-14 items-center justify-between px-3 sm:px-4 md:px-8">
          <div className="flex items-center gap-2 sm:gap-4">
            <div className="flex items-center gap-2">
              <Server className="h-5 w-5" />
              <span className="font-semibold hidden sm:inline">Kiro FDS Admin</span>
            </div>
            <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
              <Button
                variant={activeTab === 'credentials' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setActiveTab('credentials')}
                className="h-7 px-2 sm:px-3 text-xs"
              >
                <Server className="h-3 w-3 sm:mr-1" />
                <span className="hidden sm:inline">凭据管理</span>
              </Button>
              <Button
                variant={activeTab === 'apikeys' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setActiveTab('apikeys')}
                className="h-7 px-2 sm:px-3 text-xs"
              >
                <Key className="h-3 w-3 sm:mr-1" />
                <span className="hidden sm:inline">API Keys</span>
              </Button>
              <Button
                variant={activeTab === 'balance-history' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setActiveTab('balance-history')}
                className="h-7 px-2 sm:px-3 text-xs"
              >
                <BarChart3 className="h-3 w-3 sm:mr-1" />
                <span className="hidden sm:inline">用量监控</span>
              </Button>
              <Button
                variant={activeTab === 'pool-status' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setActiveTab('pool-status')}
                className="h-7 px-2 sm:px-3 text-xs"
              >
                <Zap className="h-3 w-3 sm:mr-1" />
                <span className="hidden sm:inline">池状态</span>
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-1 sm:gap-2">
            {/* Token 倍率 */}
            <div className="hidden sm:flex items-center gap-1">
              {isEditingMultiplier ? (
                <form
                  className="flex items-center gap-1"
                  onSubmit={(e) => {
                    e.preventDefault()
                    const inputVal = parseFloat(inputMultiplierInput)
                    const outputVal = parseFloat(outputMultiplierInput)
                    if (isNaN(inputVal) || inputVal <= 0 || isNaN(outputVal) || outputVal <= 0) {
                      toast.error('倍率必须大于 0')
                      return
                    }
                    setMultipliers({ inputMultiplier: inputVal, outputMultiplier: outputVal }, {
                      onSuccess: () => {
                        toast.success(`Token 倍率已设置为 输入:${inputVal}x / 输出:${outputVal}x`)
                        setIsEditingMultiplier(false)
                      },
                      onError: (error) => {
                        toast.error(`设置失败: ${extractErrorMessage(error)}`)
                      }
                    })
                  }}
                >
                  <span className="text-xs text-muted-foreground">输入:</span>
                  <input
                    type="number"
                    step="0.1"
                    min="0.1"
                    value={inputMultiplierInput}
                    onChange={(e) => setInputMultiplierInput(e.target.value)}
                    className="w-16 h-8 px-2 text-sm border rounded bg-background text-foreground"
                    autoFocus
                    disabled={isSettingMultiplier}
                  />
                  <span className="text-xs text-muted-foreground">输出:</span>
                  <input
                    type="number"
                    step="0.1"
                    min="0.1"
                    value={outputMultiplierInput}
                    onChange={(e) => setOutputMultiplierInput(e.target.value)}
                    className="w-16 h-8 px-2 text-sm border rounded bg-background text-foreground"
                    disabled={isSettingMultiplier}
                  />
                  <Button type="submit" size="sm" variant="outline" disabled={isSettingMultiplier}>
                    确定
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setIsEditingMultiplier(false)} disabled={isSettingMultiplier}>
                    取消
                  </Button>
                </form>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setInputMultiplierInput(String(multipliersData?.inputMultiplier ?? 1))
                    setOutputMultiplierInput(String(multipliersData?.outputMultiplier ?? 1))
                    setIsEditingMultiplier(true)
                  }}
                  title="点击修改 Token 倍率"
                >
                  输入: {multipliersData?.inputMultiplier ?? 1}x / 输出: {multipliersData?.outputMultiplier ?? 1}x
                </Button>
              )}
            </div>
            <span className="text-xs text-muted-foreground hidden sm:inline">v1.5.2</span>
            <Button
              variant="outline"
              size="sm"
              onClick={handleToggleLoadBalancing}
              disabled={isLoadingMode || isSettingMode}
              title="切换负载均衡模式"
              className="hidden sm:inline-flex"
            >
              {isLoadingMode ? '加载中...' : (loadBalancingData?.mode === 'priority' ? '优先级模式' : '均衡负载')}
            </Button>
            <Button variant="ghost" size="icon" onClick={toggleDarkMode}>
              {darkMode ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </Button>
            <Button variant="ghost" size="icon" onClick={handleRefresh}>
              <RefreshCw className="h-5 w-5" />
            </Button>
            <Button variant="ghost" size="icon" onClick={handleLogout}>
              <LogOut className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </header>

      {/* 主内容 */}
      <main className="container mx-auto px-3 sm:px-4 md:px-8 py-4 sm:py-6">
        {activeTab === 'apikeys' ? (
          <ApiKeysPanel />
        ) : activeTab === 'balance-history' ? (
          <BalanceHistoryPanel />
        ) : activeTab === 'pool-status' ? (
          <PoolStatusPanel />
        ) : (
        <>
        {/* 统计卡片 */}
        <div className="grid gap-4 md:grid-cols-4 mb-6">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                凭据总数
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{data?.total || 0}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                可用凭据
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">{data?.available || 0}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                当前活跃
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold flex items-center gap-2">
                #{data?.currentId || '-'}
                <Badge variant="success">活跃</Badge>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                全局 RPM
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-600">{rpmData?.global ?? '-'}</div>
            </CardContent>
          </Card>
        </div>

        {/* 凭据列表 */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <h2 className="text-xl font-semibold">凭据管理</h2>
              {/* 状态筛选 */}
              <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5">
                {([
                  { key: 'all', label: '全部', count: data?.credentials.length || 0 },
                  { key: 'active', label: '正常', count: (data?.credentials.length || 0) - disabledCredentialCount - failedCredentialCount },
                  { key: 'disabled', label: '禁用', count: disabledCredentialCount },
                  { key: 'failed', label: '异常', count: failedCredentialCount },
                ]).map(({ key, label, count }) => (
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
                {Object.keys(tierCounts).length > 0 && (
                  <div className="w-px h-4 bg-border mx-0.5" />
                )}
                {Object.entries(tierCounts).map(([tier, count]) => {
                  const key = `tier:${tier.toLowerCase()}`
                  return (
                    <button
                      key={key}
                      onClick={() => setStatusFilter(statusFilter === key ? 'all' : key)}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                        statusFilter === key
                          ? 'bg-background shadow-sm text-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {tier}
                      <span className="ml-1 text-[10px] opacity-60">{count}</span>
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {verifying && !verifyDialogOpen && (
                <Button onClick={() => setVerifyDialogOpen(true)} size="sm" variant="secondary">
                  <CheckCircle2 className="h-4 w-4 mr-2 animate-spin" />
                  验活中... {verifyProgress.current}/{verifyProgress.total}
                </Button>
              )}
              {data?.credentials && data.credentials.length > 0 && (
                <Button
                  onClick={handleQueryCurrentPageInfo}
                  size="sm"
                  variant="outline"
                  disabled={queryingInfo}
                >
                  <RefreshCw className={`h-4 w-4 sm:mr-2 ${queryingInfo ? 'animate-spin' : ''}`} />
                  <span className="hidden sm:inline">{queryingInfo ? `查询中... ${queryInfoProgress.current}/${queryInfoProgress.total}` : '查询信息'}</span>
                </Button>
              )}
              {data?.credentials && data.credentials.length > 0 && (
                <Button
                  onClick={handleClearAll}
                  size="sm"
                  variant="outline"
                  className="text-destructive hover:text-destructive"
                  disabled={disabledCredentialCount === 0}
                  title={disabledCredentialCount === 0 ? '没有可清除的已禁用凭据' : undefined}
                >
                  <Trash2 className="h-4 w-4 sm:mr-2" />
                  <span className="hidden sm:inline">清除已禁用</span>
                </Button>
              )}
              {data?.credentials && data.credentials.length > 0 && (
                <Button
                  onClick={handleDeleteAllCredentials}
                  size="sm"
                  variant="destructive"
                  disabled={isDeletingAllCredentials}
                  title="删除全部凭据"
                >
                  <Trash2 className="h-4 w-4 sm:mr-2" />
                  <span className="hidden sm:inline">删除全部</span>
                </Button>
              )}
              <Button onClick={() => setKamImportDialogOpen(true)} size="sm" variant="outline">
                <FileUp className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">KAM 导入</span>
              </Button>
              <Button onClick={() => setBatchImportDialogOpen(true)} size="sm" variant="outline">
                <Upload className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">批量导入</span>
              </Button>
              <Button onClick={() => handleExportCredentials(true)} size="sm" variant="outline">
                <Download className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">导出全部</span>
              </Button>
              <Button onClick={() => setAddDialogOpen(true)} size="sm">
                <Plus className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">添加凭据</span>
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:max-w-md">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={credentialSearch}
                onChange={(event) => setCredentialSearch(event.target.value)}
                placeholder="搜索 ID、邮箱、订阅、认证方式、代理"
                className="h-9 pl-8 pr-8"
              />
              {credentialSearch && (
                <button
                  type="button"
                  onClick={() => setCredentialSearch('')}
                  className="absolute right-2 top-1/2 rounded-sm p-1 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label="清空搜索"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {searchQuery && (
              <div className="text-xs text-muted-foreground">
                匹配 {filteredCredentials.length} / {data?.credentials.length || 0} 个凭据
              </div>
            )}
          </div>
          {data?.credentials.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                暂无凭据
              </CardContent>
            </Card>
          ) : filteredCredentials.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                没有匹配的凭据
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-1">
                {currentCredentials.map((credential) => (
                  <CredentialCard
                    key={credential.id}
                    credential={credential}
                    onViewBalance={handleViewBalance}
                    selected={selectedIds.has(credential.id)}
                    onToggleSelect={() => toggleSelect(credential.id)}
                    balance={balanceMap.get(credential.id) || null}
                    loadingBalance={loadingBalanceIds.has(credential.id)}
                    rpm={rpmData?.byCredential?.[String(credential.id)] ?? 0}
                  />
                ))}
              </div>

              {/* 分页控件 */}
              {totalPages > 1 && (
                <div className="flex justify-center items-center gap-2 sm:gap-4 mt-6">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                  >
                    上一页
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    <span className="sm:hidden">{currentPage}/{totalPages}</span>
                    <span className="hidden sm:inline">第 {currentPage} / {totalPages} 页（共 {filteredCredentials.length} 个凭据）</span>
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                  >
                    下一页
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
        </>
        )}
      </main>

      {/* 底部浮动操作栏 */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-4 fade-in-0 duration-200">
          <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl border bg-background/95 backdrop-blur shadow-lg">
            <Badge variant="secondary" className="shrink-0">已选 {selectedIds.size}</Badge>
            <Button
              onClick={() => {
                const allIds = new Set(data?.credentials.map(c => c.id) || [])
                setSelectedIds(allIds)
              }}
              size="sm"
              variant="ghost"
              disabled={selectedIds.size === (data?.credentials.length || 0)}
            >
              全选
            </Button>
            <div className="w-px h-5 bg-border" />
            <Button onClick={handleBatchVerify} size="sm" variant="outline">
              <CheckCircle2 className="h-4 w-4 mr-1" />验活
            </Button>
            <Button onClick={() => handleExportCredentials(false)} size="sm" variant="outline">
              <Download className="h-4 w-4 mr-1" />导出
            </Button>
            <Button onClick={handleBatchResetFailure} size="sm" variant="outline">
              <RotateCcw className="h-4 w-4 mr-1" />恢复
            </Button>
            <Button
              onClick={handleBatchDelete}
              size="sm"
              variant="destructive"
            >
              <Trash2 className="h-4 w-4 mr-1" />删除
            </Button>
            <div className="w-px h-5 bg-border" />
            <Button onClick={deselectAll} size="sm" variant="ghost">
              取消
            </Button>
          </div>
        </div>
      )}

      {/* 余额对话框 */}
      <BalanceDialog
        credentialId={selectedCredentialId}
        open={balanceDialogOpen}
        onOpenChange={setBalanceDialogOpen}
      />

      {/* 添加凭据对话框 */}
      <AddCredentialDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
      />

      {/* 批量导入对话框 */}
      <BatchImportDialog
        open={batchImportDialogOpen}
        onOpenChange={setBatchImportDialogOpen}
      />

      {/* KAM 账号导入对话框 */}
      <KamImportDialog
        open={kamImportDialogOpen}
        onOpenChange={setKamImportDialogOpen}
      />

      {/* 批量验活对话框 */}
      <BatchVerifyDialog
        open={verifyDialogOpen}
        onOpenChange={setVerifyDialogOpen}
        verifying={verifying}
        progress={verifyProgress}
        results={verifyResults}
        onCancel={handleCancelVerify}
      />
    </div>
  )
}
