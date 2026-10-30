import { CheckCircle, Info, Lightbulb, Warning, XCircle } from '@phosphor-icons/react/dist/ssr'

import { cn } from '@repo/ui/lib/utils'

type CalloutType = 'info' | 'warning' | 'success' | 'error' | 'tip'

type CalloutProps = {
  type?: CalloutType
  title?: string
  children: React.ReactNode
  className?: string
}

const calloutConfig: Record<
  CalloutType,
  {
    icon: typeof Info
    iconColor: string
    bgColor: string
    borderColor: string
  }
> = {
  info: {
    icon: Info,
    iconColor: 'text-blue-400',
    bgColor: 'bg-blue-500/10',
    borderColor: 'border-blue-500/30',
  },
  tip: {
    icon: Lightbulb,
    iconColor: 'text-amber-400',
    bgColor: 'bg-amber-500/10',
    borderColor: 'border-amber-500/30',
  },
  warning: {
    icon: Warning,
    iconColor: 'text-yellow-400',
    bgColor: 'bg-yellow-500/10',
    borderColor: 'border-yellow-500/30',
  },
  success: {
    icon: CheckCircle,
    iconColor: 'text-green-400',
    bgColor: 'bg-green-500/10',
    borderColor: 'border-green-500/30',
  },
  error: {
    icon: XCircle,
    iconColor: 'text-red-400',
    bgColor: 'bg-red-500/10',
    borderColor: 'border-red-500/30',
  },
}

export function Callout({ type = 'info', title, children, className }: CalloutProps) {
  const config = calloutConfig[type]
  const Icon = config.icon

  return (
    <div
      className={cn('my-6 rounded-lg border p-4', config.bgColor, config.borderColor, className)}
    >
      {title && (
        <div className="flex items-center gap-2 mb-2">
          <Icon className={cn('h-5 w-5 shrink-0', config.iconColor)} weight="fill" />
          <p className="font-semibold text-sm m-0 italic [font-family:var(--font-display)]">
            {title}
          </p>
        </div>
      )}
      {!title && (
        <Icon
          className={cn('h-5 w-5 shrink-0 float-left mr-2 mt-0.5', config.iconColor)}
          weight="fill"
        />
      )}
      <div className="text-lv2-fg-soft text-lg leading-7 italic [font-family:var(--font-display)] [&>p]:m-0">
        {children}
      </div>
    </div>
  )
}
