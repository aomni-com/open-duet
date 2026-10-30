import type { ReactNode } from 'react'

export function StatePage({
  title,
  body,
  busy = false,
  action,
}: {
  title: string
  body: string
  busy?: boolean
  action?: ReactNode
}) {
  return (
    <main className="grid min-h-screen place-items-center bg-sidebar p-6 text-foreground">
      <InlineState title={title} body={body} busy={busy} action={action} />
    </main>
  )
}

export function InlineState({
  title,
  body,
  busy = false,
  action,
}: {
  title: string
  body: string
  busy?: boolean
  action?: ReactNode
}) {
  return (
    <section
      role={busy ? 'status' : undefined}
      aria-busy={busy || undefined}
      aria-live={busy ? 'polite' : undefined}
      className="mx-auto my-8 w-full max-w-xl rounded-xl border bg-background p-8 shadow-sm"
    >
      {busy ? (
        <div className="mb-5 h-2 w-24 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
      ) : null}
      <h1 className="font-serif text-2xl font-normal italic tracking-tight">{title}</h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">{body}</p>
      {action ? <div className="mt-6">{action}</div> : null}
    </section>
  )
}
