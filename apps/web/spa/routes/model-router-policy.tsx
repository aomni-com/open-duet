'use client'

import {
  ArrowUpIcon,
  ArrowDownIcon,
  PlusIcon,
  TrashIcon,
  SpinnerGapIcon,
} from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'

import {
  InternalAdminModelRouterPolicyRequestSchema,
  validateModelRouterPolicy,
  type ModelRouterRule,
} from '@repo/contract'
import { buttonVariants } from '@repo/ui/components/shadcn/button'
import { cn } from '@repo/ui/lib/utils'

import { duetQueryKeys } from '../api/query-keys'
import { duetQueryOptions } from '../api/query-options'
import type { InternalAdminApi } from './internal-admin'

export function ModelRouterOperations({ api }: { api: InternalAdminApi }) {
  const t = useTranslations('duetAdmin')
  const queryClient = useQueryClient()
  const policy = useQuery(duetQueryOptions.admin.modelRouterPolicy(api))
  const [rules, setRules] = useState<ModelRouterRule[]>(() => policy.data?.rules ?? [])
  const [dirty, setDirty] = useState(false)
  const [reason, setReason] = useState(() => t('defaults.modelRouterReason'))
  const [importJson, setImportJson] = useState('')
  const [validationError, setValidationError] = useState<string>()
  useEffect(() => {
    if (policy.data !== undefined && !dirty) setRules(policy.data.rules)
  }, [policy.data, dirty])
  const save = useMutation({
    mutationFn: () => {
      const input = InternalAdminModelRouterPolicyRequestSchema.safeParse({
        rules,
        reason,
      })
      if (!input.success) {
        setValidationError(input.error.issues[0]?.message ?? 'Invalid policy.')
        throw new Error('invalid_model_router_policy')
      }
      const error = validateModelRouterPolicy({ version: 1, rules: input.data.rules, updatedAt: 0 })
      if (error !== null) {
        setValidationError(error)
        throw new Error('invalid_model_router_policy')
      }
      setValidationError(undefined)
      return api.internalAdminSetModelRouterPolicy(input.data)
    },
    onSuccess: result => {
      setRules(result.rules)
      setDirty(false)
      queryClient.setQueryData(duetQueryKeys.admin.modelRouterPolicy, result)
    },
  })
  const edit = () => {
    setDirty(true)
    setValidationError(undefined)
    save.reset()
  }
  const updateRule = (index: number, update: Partial<ModelRouterRule>) => {
    edit()
    setRules(current =>
      current.map((rule, ruleIndex) => (ruleIndex === index ? { ...rule, ...update } : rule)),
    )
  }
  const addRule = () => {
    edit()
    setRules(current => [
      ...current,
      {
        id: crypto.randomUUID(),
        enabled: true,
        modelGlob: 'openai/*',
        baseUrl: '',
        headers: [{ name: 'authorization', value: 'Bearer ' }],
      },
    ])
  }
  const removeRule = (index: number) => {
    edit()
    setRules(current => current.filter((_, ruleIndex) => ruleIndex !== index))
  }
  const moveRule = (index: number, direction: -1 | 1) => {
    edit()
    setRules(current => {
      const next = [...current]
      const moved = next.splice(index, 1)[0]!
      next.splice(index + direction, 0, moved)
      return next
    })
  }
  const previewRules = rules.map(rule => ({
    ...rule,
    headers: rule.headers.map(header => ({
      ...header,
      value: isSensitiveRouteHeader(header.name) ? '••••••••' : header.value,
    })),
  }))
  if (policy.data === undefined) {
    return (
      <div className="rounded-xl border p-6">
        <p role={policy.isError ? 'alert' : 'status'}>
          {t(policy.isError ? 'error.body' : 'loading.modelRouter')}
        </p>
        {policy.isError ? (
          <button
            className={cn(buttonVariants({ variant: 'outline' }), 'mt-3')}
            onClick={() => void policy.refetch()}
          >
            {t('error.retry')}
          </button>
        ) : null}
      </div>
    )
  }
  return (
    <fieldset
      className="space-y-5 rounded-xl border bg-background p-5 shadow-sm sm:p-7"
      data-testid="model-router-policy"
      disabled={save.isPending}
    >
      <div>
        <h2 className="text-lg font-semibold">{t('modelRouter.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('modelRouter.body')}</p>
      </div>
      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-semibold">{t('modelRouter.routesTitle')}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t('modelRouter.routesBody')}</p>
          </div>
          <button
            type="button"
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'shrink-0 gap-1.5')}
            onClick={addRule}
            disabled={rules.length >= 100}
          >
            <PlusIcon aria-hidden="true" />
            {t('modelRouter.addRoute')}
          </button>
        </div>
        {rules.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {t('modelRouter.emptyRoutes')}
          </div>
        ) : (
          <div className="space-y-4">
            {rules.map((rule, index) => (
              <div
                key={rule.id}
                role="group"
                aria-label={t('modelRouter.route', { number: index + 1 })}
                className="rounded-lg border bg-muted/10 p-4 sm:p-5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">
                      {t('modelRouter.route', { number: index + 1 })}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('modelRouter.routeBody')}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {([-1, 1] as const).map(direction => (
                      <button
                        key={direction}
                        type="button"
                        className={buttonVariants({ variant: 'outline', size: 'icon' })}
                        disabled={direction === -1 ? index === 0 : index === rules.length - 1}
                        title={t(direction === -1 ? 'modelRouter.moveUp' : 'modelRouter.moveDown')}
                        aria-label={t(
                          direction === -1 ? 'modelRouter.moveUp' : 'modelRouter.moveDown',
                        )}
                        onClick={() => moveRule(index, direction)}
                      >
                        {direction === -1 ? (
                          <ArrowUpIcon aria-hidden="true" />
                        ) : (
                          <ArrowDownIcon aria-hidden="true" />
                        )}
                      </button>
                    ))}
                    <button
                      type="button"
                      className={cn(
                        buttonVariants({ variant: 'ghost', size: 'icon' }),
                        'text-muted-foreground hover:text-destructive',
                      )}
                      aria-label={t('modelRouter.removeRoute', {
                        number: index + 1,
                      })}
                      title={t('modelRouter.removeRoute', { number: index + 1 })}
                      onClick={() => removeRule(index)}
                    >
                      <TrashIcon aria-hidden="true" />
                    </button>
                  </div>
                </div>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <label className="space-y-1.5 text-sm font-medium">
                    <span>{t('modelRouter.modelPattern')}</span>
                    <input
                      className="h-9 w-full rounded-md border bg-background px-3 font-mono text-xs"
                      value={rule.modelGlob}
                      aria-label={t('modelRouter.modelPattern')}
                      placeholder="openai/*"
                      onChange={event => updateRule(index, { modelGlob: event.target.value })}
                    />
                    <span className="block text-xs font-normal text-muted-foreground">
                      {t('modelRouter.modelPatternHint')}
                    </span>
                  </label>
                  <label className="space-y-1.5 text-sm font-medium">
                    <span>{t('modelRouter.endpoint')}</span>
                    <input
                      className="h-9 w-full rounded-md border bg-background px-3 font-mono text-xs"
                      value={rule.baseUrl}
                      aria-label={t('modelRouter.endpoint')}
                      placeholder="https://provider.example"
                      onChange={event => updateRule(index, { baseUrl: event.target.value })}
                    />
                    <span className="block text-xs font-normal text-muted-foreground">
                      {t('modelRouter.endpointHint')}
                    </span>
                  </label>
                </div>
                <label className="mt-4 flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    className="size-4 accent-brand"
                    checked={rule.enabled}
                    onChange={event => updateRule(index, { enabled: event.target.checked })}
                  />
                  {t('modelRouter.enabled')}
                </label>
                <div className="mt-4 rounded-md border bg-background p-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-sm font-medium">{t('modelRouter.headersTitle')}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t('modelRouter.headersBody')}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={rule.headers.length >= 32}
                      className={cn(
                        buttonVariants({ variant: 'outline', size: 'sm' }),
                        'self-start gap-1.5',
                      )}
                      onClick={() =>
                        updateRule(index, {
                          headers: [...rule.headers, { name: '', value: '' }],
                        })
                      }
                    >
                      <PlusIcon aria-hidden="true" />
                      {t('modelRouter.addHeader')}
                    </button>
                  </div>
                  <div className="mt-3 space-y-2">
                    {rule.headers.map((header, headerIndex) => (
                      <div
                        key={`${rule.id}-header-${headerIndex}`}
                        className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]"
                      >
                        <label className="min-w-0 space-y-1 text-xs font-medium">
                          <span>{t('modelRouter.headerName', { number: headerIndex + 1 })}</span>
                          <input
                            className="h-9 w-full rounded-md border bg-background px-3 font-mono text-xs"
                            aria-label={t('modelRouter.headerName', {
                              number: headerIndex + 1,
                            })}
                            placeholder="authorization"
                            value={header.name}
                            onChange={event =>
                              updateRule(index, {
                                headers: rule.headers.map((current, currentIndex) =>
                                  currentIndex === headerIndex
                                    ? { ...current, name: event.target.value }
                                    : current,
                                ),
                              })
                            }
                          />
                        </label>
                        <label className="col-span-2 min-w-0 space-y-1 text-xs font-medium sm:col-span-1">
                          <span>{t('modelRouter.headerValue', { number: headerIndex + 1 })}</span>
                          <input
                            className="h-9 w-full rounded-md border bg-background px-3 font-mono text-xs"
                            aria-label={t('modelRouter.headerValue', {
                              number: headerIndex + 1,
                            })}
                            placeholder="Bearer …"
                            type={isSensitiveRouteHeader(header.name) ? 'password' : 'text'}
                            autoComplete="off"
                            value={header.value}
                            onChange={event =>
                              updateRule(index, {
                                headers: rule.headers.map((current, currentIndex) =>
                                  currentIndex === headerIndex
                                    ? { ...current, value: event.target.value }
                                    : current,
                                ),
                              })
                            }
                          />
                        </label>
                        <button
                          type="button"
                          aria-label={t('modelRouter.removeHeader', {
                            number: headerIndex + 1,
                          })}
                          title={t('modelRouter.removeHeader', {
                            number: headerIndex + 1,
                          })}
                          className={cn(
                            buttonVariants({ variant: 'ghost', size: 'icon' }),
                            'col-start-2 row-start-1 self-end text-muted-foreground hover:text-destructive sm:col-auto sm:row-auto',
                          )}
                          onClick={() =>
                            updateRule(index, {
                              headers: rule.headers.filter(
                                (_, currentIndex) => currentIndex !== headerIndex,
                              ),
                            })
                          }
                        >
                          <TrashIcon aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <details className="rounded-lg border bg-muted/10 p-3">
        <summary className="cursor-pointer text-sm font-medium">
          {t('modelRouter.advancedJson')}
        </summary>
        <pre className="mt-3 max-h-64 overflow-auto rounded-md border bg-background p-3 font-mono text-xs text-muted-foreground">
          {JSON.stringify(previewRules, null, 2)}
        </pre>
        <button
          type="button"
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-3')}
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([JSON.stringify(rules, null, 2)], { type: 'application/json' }),
            )
            const anchor = document.createElement('a')
            anchor.href = url
            anchor.download = 'model-router-rules.json'
            anchor.click()
            URL.revokeObjectURL(url)
          }}
        >
          {t('modelRouter.exportJson')}
        </button>
        <label className="mt-4 block text-sm font-medium">
          {t('modelRouter.importJson')}
          <textarea
            className="mt-2 min-h-28 w-full rounded-md border bg-background p-3 font-mono text-xs"
            aria-label={t('modelRouter.importJson')}
            value={importJson}
            spellCheck={false}
            onChange={event => setImportJson(event.target.value)}
          />
        </label>
        <button
          type="button"
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-2')}
          disabled={!importJson.trim()}
          onClick={() => {
            try {
              const input = InternalAdminModelRouterPolicyRequestSchema.parse({
                rules: JSON.parse(importJson),
                reason,
              })
              const error = validateModelRouterPolicy({
                version: 1,
                rules: input.rules,
                updatedAt: 0,
              })
              if (error !== null) throw new Error(error)
              edit()
              setRules(input.rules)
              setImportJson('')
            } catch {
              setValidationError(t('modelRouter.importError'))
            }
          }}
        >
          {t('modelRouter.applyJson')}
        </button>
      </details>
      <label className="block text-sm font-medium">
        {t('reason')}
        <input
          className="mt-2 h-9 w-full rounded-md border bg-background px-3 text-sm"
          value={reason}
          onChange={event => {
            edit()
            setReason(event.target.value)
          }}
        />
      </label>
      {validationError !== undefined ? (
        <p className="text-sm text-destructive">{validationError}</p>
      ) : null}
      {save.isError && validationError === undefined ? (
        <p className="text-sm text-destructive">{t('error.mutation')}</p>
      ) : null}
      {save.isSuccess ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('saved')}
        </p>
      ) : null}
      <button
        className={cn(buttonVariants(), 'disabled:opacity-100')}
        disabled={save.isPending}
        aria-busy={save.isPending}
        onClick={() => save.mutate()}
      >
        {save.isPending ? <SpinnerGapIcon className="animate-spin" aria-hidden="true" /> : null}
        {save.isPending ? t('saving') : t('save')}
      </button>
    </fieldset>
  )
}

function isSensitiveRouteHeader(name: string): boolean {
  return /authorization|api[-_]?key|token|secret|password/i.test(name)
}
