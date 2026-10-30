'use client'

import {
  CheckCircleIcon,
  InfoIcon,
  WarningCircleIcon,
  XCircleIcon,
  XIcon,
} from '@phosphor-icons/react'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react'

export type ToastInput = {
  message: string
  description?: string
  tone?: 'info' | 'success' | 'warning' | 'error'
  // A toast that reports a condition the user must act on outlives the timer:
  // dismissal is then the user's decision, not the clock's.
  persist?: boolean
  action?: { label: string; href: string } | { label: string; onClick: () => void }
}

type Toast = ToastInput & { id: number }

const ToastContext = createContext<((input: string | ToastInput) => void) | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(0)
  const dismiss = useCallback((id: number) => {
    setToasts(current => current.filter(toast => toast.id !== id))
  }, [])
  const showToast = useCallback(
    (input: string | ToastInput) => {
      const id = nextId.current++
      const toast = typeof input === 'string' ? { message: input } : input
      setToasts(current => [...current, { id, ...toast }])
      if (!toast.persist) window.setTimeout(() => dismiss(id), 6_000)
    },
    [dismiss],
  )
  const value = useMemo(() => showToast, [showToast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-4 bottom-24 z-[80] flex flex-col items-end gap-2 sm:bottom-4 sm:left-auto sm:w-96"
      >
        {toasts.map(toast => (
          <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function ToastCard({ toast, onDismiss }: { toast: ToastInput; onDismiss: () => void }) {
  const info = toast.tone === 'info'
  const warning = toast.tone === 'warning'
  const error = toast.tone === 'error'
  const Icon = error ? XCircleIcon : warning ? WarningCircleIcon : info ? InfoIcon : CheckCircleIcon
  const actionClassName =
    'mt-1.5 inline-block font-semibold text-primary underline-offset-4 hover:underline'
  return (
    <div
      role={error ? 'alert' : 'status'}
      className={`pointer-events-auto flex w-full items-start gap-3 rounded-xl border border-l-[3px] bg-card px-4 py-3 text-sm shadow-xl ${error ? 'border-destructive/40 border-l-destructive' : warning ? 'border-amber-500/35 border-l-amber-500' : info ? 'border-primary/25 border-l-primary' : 'border-emerald-500/25 border-l-emerald-500'}`}
    >
      <Icon
        className={`mt-0.5 size-5 shrink-0 ${error ? 'text-destructive' : warning ? 'text-amber-600' : info ? 'text-primary' : 'text-emerald-600'}`}
        weight="fill"
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{toast.message}</span>
        {toast.description ? (
          <span className="mt-0.5 block text-muted-foreground">{toast.description}</span>
        ) : null}
        {toast.action === undefined ? null : 'href' in toast.action ? (
          <a href={toast.action.href} className={actionClassName}>
            {toast.action.label}
          </a>
        ) : (
          <button type="button" onClick={toast.action.onClick} className={actionClassName}>
            {toast.action.label}
          </button>
        )}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <XIcon className="size-4" aria-hidden />
      </button>
    </div>
  )
}

export function useToast(): (input: string | ToastInput) => void {
  const value = useContext(ToastContext)
  if (value === null) throw new Error('Toast provider is missing')
  return value
}
