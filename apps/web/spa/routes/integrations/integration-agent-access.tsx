'use client'

import { CaretDownIcon, CircleNotchIcon, UsersThreeIcon } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useEffect, useId, useRef } from 'react'

import { ROOT_AGENT_SCOPE, type Agent } from '@repo/contract'
import { buttonVariants } from '@repo/ui/components/shadcn/button'
import { Checkbox } from '@repo/ui/components/shadcn/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/components/shadcn/popover'
import { cn } from '@repo/ui/lib/utils'

export type IntegrationAgentOption = {
  id: Agent['id']
  name: NonNullable<Agent['name']>
}

export function nextIntegrationPolicy({
  current,
  visiblePrincipalIds,
  toggledId,
  checked,
}: {
  current: string[] | undefined
  visiblePrincipalIds: string[]
  toggledId: 'all' | string
  checked: boolean
}): string[] | undefined {
  if (toggledId === 'all') return checked ? undefined : []

  const selected = new Set(current ?? visiblePrincipalIds)
  if (checked) selected.add(toggledId)
  else selected.delete(toggledId)
  return visiblePrincipalIds.filter(id => selected.has(id))
}

export function IntegrationAgentAccessEditor({
  subject,
  subjectKind = 'integration',
  allowedAgentIds,
  agents,
  pending,
  error,
  onChange,
}: {
  /** Opaque identity of whatever the policy is about — a toolkit slug or a
      custom MCP server's name. The editor never interprets it. */
  subject: string
  /* Only the locator differs by kind, and it has to: a workspace may name a
     custom server after a toolkit it also connects, and one attribute for both
     would make every `[data-integration-agent-access="gmail"]` locator match
     two editors. */
  subjectKind?: 'integration' | 'mcpServer'
  allowedAgentIds: string[] | undefined
  agents: IntegrationAgentOption[]
  pending?: boolean
  error?: boolean
  onChange(next: string[] | undefined): void
}) {
  const t = useTranslations('duetIntegrations.agentAccess')
  const id = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const visiblePrincipalIds = [ROOT_AGENT_SCOPE, ...agents.map(agent => agent.id)]
  const all = allowedAgentIds === undefined
  const visibleSelectedCount = all
    ? visiblePrincipalIds.length
    : visiblePrincipalIds.filter(principalId => allowedAgentIds.includes(principalId)).length

  const toggle = (toggledId: 'all' | string, checked: boolean) => {
    onChange(
      nextIntegrationPolicy({
        current: allowedAgentIds,
        visiblePrincipalIds,
        toggledId,
        checked,
      }),
    )
  }

  useEffect(() => {
    if (error) triggerRef.current?.focus()
  }, [error])

  const valueText = pending
    ? t('saving')
    : all
      ? t('all')
      : visibleSelectedCount === 0
        ? t('nobody')
        : t('selectedCount', { count: visibleSelectedCount })

  return (
    <div
      aria-busy={pending || undefined}
      className="flex min-w-0 flex-col items-end"
      {...(subjectKind === 'mcpServer'
        ? { 'data-mcp-server-agent-access': subject }
        : { 'data-integration-agent-access': subject })}
    >
      <Popover>
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            disabled={pending}
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'sm' }),
              'group max-w-full shrink-0 gap-1.5 text-muted-foreground hover:text-foreground',
            )}
          >
            <UsersThreeIcon className="size-4 shrink-0" weight="duotone" />
            <span className="max-w-32 truncate sm:max-w-none">{valueText}</span>
            {pending ? (
              <CircleNotchIcon aria-hidden className="size-4 shrink-0 animate-spin" />
            ) : (
              <CaretDownIcon
                aria-hidden
                className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none"
              />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-80 p-0"
          {...(subjectKind === 'mcpServer'
            ? { 'data-mcp-server-agent-access-panel': subject }
            : { 'data-integration-agent-access-panel': subject })}
        >
          <fieldset disabled={pending} className="px-4 py-3 disabled:opacity-80">
            <legend className="mb-2 font-medium">{t('title')}</legend>
            <p className="mb-2 text-xs leading-5 text-muted-foreground">
              {t('description')} {agents.length > 20 ? t('scrollHint') : null}
            </p>
            <div className="max-h-[17rem] overflow-y-auto overscroll-contain rounded-lg border bg-background p-1 [scrollbar-gutter:stable] sm:max-h-[16.25rem] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-muted/30 [&::-webkit-scrollbar]:w-2">
              <PolicyCheckbox
                id={`${id}-all`}
                label={t('all')}
                checked={all}
                onCheckedChange={checked => toggle('all', checked)}
                strong
              />
              <div className="my-1 border-t border-border/65" />
              <PolicyCheckbox
                id={`${id}-root`}
                label={t('duet')}
                checked={all || allowedAgentIds.includes(ROOT_AGENT_SCOPE)}
                onCheckedChange={checked => toggle(ROOT_AGENT_SCOPE, checked)}
              />
              {agents.map(agent => (
                <PolicyCheckbox
                  key={agent.id}
                  id={`${id}-${agent.id}`}
                  label={agent.name}
                  checked={all || allowedAgentIds.includes(agent.id)}
                  onCheckedChange={checked => toggle(agent.id, checked)}
                />
              ))}
            </div>
          </fieldset>
        </PopoverContent>
      </Popover>
      {error ? (
        <p
          role="alert"
          className="mt-1 max-w-64 text-right text-xs font-medium text-red-700 dark:text-red-300"
        >
          {t('saveError')}
        </p>
      ) : null}
    </div>
  )
}

function PolicyCheckbox({
  id,
  label,
  checked,
  strong,
  onCheckedChange,
}: {
  id: string
  label: string
  checked: boolean
  strong?: boolean
  onCheckedChange(checked: boolean): void
}) {
  return (
    <label
      htmlFor={id}
      className="flex min-h-11 min-w-0 cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted/45 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/45 sm:min-h-9"
    >
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={value => onCheckedChange(value === true)}
        className="size-5 sm:size-4"
      />
      <span className={`${strong ? 'font-semibold' : 'font-medium'} min-w-0 flex-1 truncate`}>
        {label}
      </span>
    </label>
  )
}
