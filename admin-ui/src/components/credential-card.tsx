import { useState, useRef, useEffect } from 'react'
import { toast } from 'sonner'
import { MoreHorizontal, RefreshCw, ChevronUp, ChevronDown, Wallet, Trash2, Loader2, Pencil, Power, PowerOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { CredentialStatusItem, BalanceResponse } from '@/types/api'
import {
  useSetDisabled,
  useSetPriority,
  useResetFailure,
  useDeleteCredential,
} from '@/hooks/use-credentials'
import { EditCredentialDialog } from './edit-credential-dialog'

interface CredentialCardProps {
  credential: CredentialStatusItem
  onViewBalance: (id: number) => void
  selected: boolean
  onToggleSelect: () => void
  balance: BalanceResponse | null
  loadingBalance: boolean
  rpm?: number
}

function formatLastUsed(lastUsedAt: string | null): string {
  if (!lastUsedAt) return '从未'
  const date = new Date(lastUsedAt)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  if (diff < 0) return '刚刚'
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

function formatUsage(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return value.toFixed(0)
}

// 下拉菜单组件
function DropdownMenu({ children, trigger }: { children: React.ReactNode, trigger: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen(!open)}>{trigger}</div>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 min-w-[160px] rounded-md border bg-popover p-1 shadow-md animate-in fade-in-0 zoom-in-95">
          <div onClick={() => setOpen(false)}>{children}</div>
        </div>
      )}
    </div>
  )
}

function DropdownItem({ children, onClick, disabled, destructive }: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  destructive?: boolean
}) {
  return (
    <button
      className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors
        ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-accent'}
        ${destructive ? 'text-destructive hover:text-destructive' : ''}`}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}

export function CredentialCard({
  credential,
  onViewBalance,
  selected,
  onToggleSelect,
  balance,
  loadingBalance,
  rpm = 0,
}: CredentialCardProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [showEditDialog, setShowEditDialog] = useState(false)

  const setDisabled = useSetDisabled()
  const setPriority = useSetPriority()
  const resetFailure = useResetFailure()
  const deleteCredential = useDeleteCredential()

  const handleToggleDisabled = () => {
    setDisabled.mutate(
      { id: credential.id, disabled: !credential.disabled },
      {
        onSuccess: (res) => toast.success(res.message),
        onError: (err) => toast.error('操作失败: ' + (err as Error).message),
      }
    )
  }

  const handleReset = () => {
    resetFailure.mutate(credential.id, {
      onSuccess: (res) => toast.success(res.message),
      onError: (err) => toast.error('操作失败: ' + (err as Error).message),
    })
  }

  const handleDelete = () => {
    if (!credential.disabled) {
      toast.error('请先禁用凭据再删除')
      setShowDeleteDialog(false)
      return
    }
    deleteCredential.mutate(credential.id, {
      onSuccess: (res) => {
        toast.success(res.message)
        setShowDeleteDialog(false)
      },
      onError: (err) => toast.error('删除失败: ' + (err as Error).message),
    })
  }

  // 状态颜色
  const isHealthy = !credential.disabled && credential.failureCount === 0
  const hasFailure = credential.failureCount > 0
  const statusColor = credential.disabled
    ? 'bg-gray-400'
    : hasFailure
      ? 'bg-yellow-500'
      : 'bg-emerald-500'

  // 余额信息
  const usagePercent = balance ? balance.usagePercentage : null
  const isLowBalance = usagePercent !== null && usagePercent > 80

  return (
    <>
      <div
        className={`group flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-all hover:bg-accent/50
          ${credential.isCurrent ? 'ring-2 ring-primary bg-primary/5' : ''}
          ${selected ? 'bg-accent' : ''}
          ${credential.disabled ? 'opacity-60' : ''}`}
      >
        {/* 选择框 */}
        <Checkbox
          checked={selected}
          onCheckedChange={onToggleSelect}
          className="shrink-0"
        />

        {/* 状态灯 */}
        <div className={`w-2 h-2 rounded-full shrink-0 ${statusColor}`} title={
          credential.disabled ? '已禁用' : hasFailure ? `失败 ${credential.failureCount} 次` : '正常'
        } />

        {/* 邮箱 + 标签 */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-sm font-medium truncate">
            {credential.email || `#${credential.id}`}
          </span>
          {credential.isCurrent && (
            <Badge variant="success" className="shrink-0 text-[10px] px-1.5 py-0">活跃</Badge>
          )}
          {hasFailure && !credential.disabled && (
            <Badge variant="destructive" className="shrink-0 text-[10px] px-1.5 py-0">
              {credential.failureCount}
            </Badge>
          )}
        </div>

        {/* 已用额度 */}
        <div className="shrink-0 w-[100px] text-right">
          {loadingBalance ? (
            <Loader2 className="inline w-3 h-3 animate-spin text-muted-foreground" />
          ) : balance ? (
            <span className={`text-xs tabular-nums ${isLowBalance ? 'text-red-500 font-medium' : 'text-muted-foreground'}`}>
              {formatUsage(balance.currentUsage)}/{formatUsage(balance.usageLimit)}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </div>

        {/* RPM */}
        <div className="hidden lg:block shrink-0 w-12 text-right">
          <span className={`text-xs tabular-nums ${rpm > 0 ? 'text-blue-600 font-medium' : 'text-muted-foreground'}`}>
            {rpm > 0 ? rpm : '—'}
          </span>
          {rpm > 0 && <span className="text-[10px] text-muted-foreground ml-0.5">rpm</span>}
        </div>

        {/* 最后调用 */}
        <div className="hidden lg:block shrink-0 w-10 text-right">
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatLastUsed(credential.lastUsedAt)}
          </span>
        </div>

        {/* 成功次数 */}
        <div className="hidden xl:block shrink-0 w-14 text-right">
          <span className="text-xs text-muted-foreground tabular-nums">
            {credential.successCount > 0 ? formatUsage(credential.successCount) : '—'}
          </span>
        </div>

        {/* 操作菜单 */}
        <DropdownMenu
          trigger={
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          }
        >
          <DropdownItem onClick={() => onViewBalance(credential.id)}>
            <Wallet className="h-3.5 w-3.5" />查看余额
          </DropdownItem>
          <DropdownItem onClick={() => setShowEditDialog(true)}>
            <Pencil className="h-3.5 w-3.5" />编辑
          </DropdownItem>
          <DropdownItem onClick={handleToggleDisabled} disabled={setDisabled.isPending}>
            {credential.disabled
              ? <><Power className="h-3.5 w-3.5" />启用</>
              : <><PowerOff className="h-3.5 w-3.5" />禁用</>
            }
          </DropdownItem>
          <DropdownItem
            onClick={() => {
              const newPriority = Math.max(0, credential.priority - 1)
              setPriority.mutate(
                { id: credential.id, priority: newPriority },
                {
                  onSuccess: (res) => toast.success(res.message),
                  onError: (err) => toast.error('操作失败: ' + (err as Error).message),
                }
              )
            }}
            disabled={setPriority.isPending || credential.priority === 0}
          >
            <ChevronUp className="h-3.5 w-3.5" />提高优先级
          </DropdownItem>
          <DropdownItem
            onClick={() => {
              setPriority.mutate(
                { id: credential.id, priority: credential.priority + 1 },
                {
                  onSuccess: (res) => toast.success(res.message),
                  onError: (err) => toast.error('操作失败: ' + (err as Error).message),
                }
              )
            }}
            disabled={setPriority.isPending}
          >
            <ChevronDown className="h-3.5 w-3.5" />降低优先级
          </DropdownItem>
          <DropdownItem onClick={handleReset} disabled={resetFailure.isPending || credential.failureCount === 0}>
            <RefreshCw className="h-3.5 w-3.5" />重置失败
          </DropdownItem>
          <div className="my-1 border-t" />
          <DropdownItem onClick={() => setShowDeleteDialog(true)} disabled={!credential.disabled} destructive>
            <Trash2 className="h-3.5 w-3.5" />删除
          </DropdownItem>
        </DropdownMenu>
      </div>

      {/* 删除确认对话框 */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认删除凭据</DialogTitle>
            <DialogDescription>
              确定要删除凭据 #{credential.id} ({credential.email}) 吗？此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)} disabled={deleteCredential.isPending}>
              取消
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteCredential.isPending || !credential.disabled}>
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 编辑凭据对话框 */}
      <EditCredentialDialog
        open={showEditDialog}
        onOpenChange={setShowEditDialog}
        credential={credential}
      />
    </>
  )
}
