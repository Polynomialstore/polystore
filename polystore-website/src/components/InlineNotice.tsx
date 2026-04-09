import type { ReactNode } from 'react'
import { AlertCircle, CheckCircle2, RefreshCw } from 'lucide-react'

import { cn } from '../lib/utils'

export type InlineNoticeTone = 'pending' | 'success' | 'error' | 'info'

type InlineNoticeProps = {
  tone: InlineNoticeTone
  title: string
  children: ReactNode
  className?: string
  testId?: string
}

export function InlineNotice({ tone, title, children, className, testId }: InlineNoticeProps) {
  const toneClass =
    tone === 'error'
      ? 'border-destructive/40 bg-destructive/10 text-destructive'
      : tone === 'success'
        ? 'border-success/40 bg-success/10 text-success'
        : 'border-primary/30 bg-primary/10 text-primary'

  const Icon = tone === 'error' ? AlertCircle : tone === 'success' ? CheckCircle2 : RefreshCw
  const iconClass = tone === 'pending' ? 'animate-spin' : ''

  return (
    <div
      data-testid={testId}
      className={cn(
        'rounded-none border p-4 text-sm flex items-start gap-3',
        toneClass,
        className,
      )}
    >
      <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', iconClass)} />
      <div className="min-w-0">
        <div className="font-semibold" data-testid={testId ? `${testId}-title` : undefined}>
          {title}
        </div>
        <div className="mt-1 break-words" data-testid={testId ? `${testId}-message` : undefined}>
          {children}
        </div>
      </div>
    </div>
  )
}
