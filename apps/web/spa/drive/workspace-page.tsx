import type { ComponentPropsWithoutRef, ReactNode } from 'react'

import { cn } from '@repo/ui/lib/utils'

export function WorkspacePage({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <main className="min-h-full min-w-0 bg-background">
      <div
        className={cn(
          'mx-auto flex w-full max-w-[88rem] flex-col gap-6 px-4 pb-24 pt-5 sm:px-6 sm:pt-7 lg:px-8 lg:pb-10',
          className,
        )}
      >
        {children}
      </div>
    </main>
  )
}

export function WorkspacePageHeader({
  icon,
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  icon?: ReactNode
  eyebrow?: string
  title: string
  description?: string
  actions?: ReactNode
  className?: string
}) {
  return (
    <header
      className={cn(
        'flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-8',
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-3.5">
        {icon ? (
          <span
            aria-hidden
            className="mt-0.5 grid size-11 shrink-0 place-items-center rounded-lg bg-brand/[0.08] text-brand ring-1 ring-inset ring-brand/10 [&_svg]:size-5"
          >
            {icon}
          </span>
        ) : null}
        <div className="min-w-0">
          {eyebrow ? (
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand">
              {eyebrow}
            </p>
          ) : null}
          <h1
            className={cn(
              'font-serif text-2xl font-normal italic leading-tight tracking-tight',
              eyebrow && 'mt-1',
            )}
          >
            {title}
          </h1>
          {description ? (
            <p className="mt-2 max-w-[68ch] text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  )
}

export function WorkspaceRailTitle({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-3 flex min-w-0 items-center gap-2 px-1">
      <span
        aria-hidden
        className="grid size-7 shrink-0 place-items-center rounded-md bg-brand/[0.08] text-brand ring-1 ring-inset ring-brand/10 [&_svg]:size-4"
      >
        {icon}
      </span>
      <span className="truncate font-serif text-sm italic tracking-tight text-foreground">
        {children}
      </span>
    </div>
  )
}

export function WorkspaceEmptyState({
  icon,
  title,
  body,
  action,
  tone = 'brand',
  className,
}: {
  icon: ReactNode
  title: string
  body: string
  action?: ReactNode
  tone?: 'brand' | 'muted' | 'destructive'
  className?: string
}) {
  const tones = {
    brand: 'bg-brand/[0.08] text-brand ring-1 ring-inset ring-brand/10',
    muted: 'bg-muted text-muted-foreground',
    destructive: 'bg-destructive/10 text-destructive',
  }
  return (
    <div className={cn('grid place-items-center p-6 text-center', className)}>
      <div className="max-w-sm">
        <span
          aria-hidden
          className={cn(
            'mx-auto grid size-12 place-items-center rounded-lg [&_svg]:size-6',
            tones[tone],
          )}
        >
          {icon}
        </span>
        <h2 className="mt-4 font-serif text-lg font-normal italic tracking-tight">{title}</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{body}</p>
        {action ? <div className="mt-4">{action}</div> : null}
      </div>
    </div>
  )
}

export function WorkspacePanel({ children, className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      className={cn(
        'min-w-0 overflow-hidden rounded-xl border border-border/75 bg-card shadow-xs',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export function WorkspacePanelHeader({
  title,
  description,
  leading,
  trailing,
  className,
}: {
  title: string
  description?: string
  leading?: ReactNode
  trailing?: ReactNode
  className?: string
}) {
  return (
    <header
      className={cn(
        'flex min-w-0 items-start gap-3 border-b border-border/65 bg-muted/20 px-4 py-4 sm:px-5',
        className,
      )}
    >
      {leading ? (
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand/[0.09] text-brand ring-1 ring-inset ring-brand/10">
          {leading}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-semibold leading-5 tracking-tight">{title}</h2>
        {description ? (
          <p className="mt-1 max-w-[64ch] text-sm leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {trailing ? <div className="shrink-0">{trailing}</div> : null}
    </header>
  )
}
