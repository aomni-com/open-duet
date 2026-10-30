'use client'

import { SpinnerGapIcon } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'

import { ROOT_AGENT_SCOPE } from '@repo/contract'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@repo/ui/components/shadcn/alert-dialog'
import { Button } from '@repo/ui/components/shadcn/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@repo/ui/components/shadcn/dialog'
import { Input } from '@repo/ui/components/shadcn/input'

import { DuetApiError } from '../api/client'
import { useSpa } from '../context'
import type { AgentRosterMenuAction } from '../drive/agent-roster-types'
import { driveDestination } from '../drive/drive-routes'
import { ShareDialog, type ShareDialogTarget } from '../files/share-dialog'
import { useToast } from '../shell/toast'
import {
  useDeleteAgent,
  useRedoAgentOnboarding,
  useRenameAgent,
  useRenameDefaultAgent,
} from './agent-mutations'

// What every action surface (roster card, detail header) hands the actions hook.
// A superset of what any single action needs: rename and delete require `slug`
// (only the `agent` menu shape offers them, and it always carries one); share
// and open-in-drive read `anchorPath`.
export type AgentActionTarget = {
  name: string
  slug?: string
  anchorPath?: string
}

export type UseAgentActionsResult = {
  // Wire this to a menu surface's `onMenuAction(target, action)`.
  onMenuAction: (target: AgentActionTarget, action: AgentRosterMenuAction) => void
  // Mount once per surface — the rename, delete-confirm, and share dialogs.
  dialogs: ReactNode
}

// The single owner of the ⋯ menu's behavior, shared by the roster card and the
// detail header so neither re-implements a mutation or a dialog. `onDeleted`
// lets the detail route navigate away from a page whose agent no longer exists;
// the roster passes nothing, because a removed card needs no navigation.
export function useAgentActions(
  workspaceSlug: string,
  options: { onDeleted?: () => void } = {},
): UseAgentActionsResult {
  const navigate = useNavigate()
  const { api } = useSpa()
  const [renameTarget, setRenameTarget] = useState<{ slug: string; name: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ slug: string; name: string } | null>(null)
  const [shareTarget, setShareTarget] = useState<ShareDialogTarget | null>(null)
  const redoOnboarding = useRedoAgentOnboarding(workspaceSlug)

  const onMenuAction = (target: AgentActionTarget, action: AgentRosterMenuAction) => {
    switch (action) {
      case 'open-in-drive':
        navigate(driveDestination(workspaceSlug, target.anchorPath, 'folder'))
        return
      case 'rename':
        if (target.slug !== undefined) setRenameTarget({ slug: target.slug, name: target.name })
        return
      case 'share':
        if (target.anchorPath !== undefined)
          setShareTarget({ name: target.name, path: target.anchorPath })
        return
      case 'redo-onboarding':
        if (target.slug !== undefined) redoOnboarding.mutate(target.slug)
        return
      case 'delete':
        if (target.slug !== undefined) setDeleteTarget({ slug: target.slug, name: target.name })
        return
    }
  }

  const dialogs = (
    <>
      <RenameAgentDialog
        workspaceSlug={workspaceSlug}
        target={renameTarget}
        onOpenChange={open => {
          if (!open) setRenameTarget(null)
        }}
      />
      <DeleteAgentDialog
        workspaceSlug={workspaceSlug}
        target={deleteTarget}
        onOpenChange={open => {
          if (!open) setDeleteTarget(null)
        }}
        onDeleted={options.onDeleted}
      />
      <ShareDialog
        api={api}
        workspaceSlug={workspaceSlug}
        target={shareTarget}
        open={shareTarget !== null}
        onOpenChange={open => {
          if (!open) setShareTarget(null)
        }}
      />
    </>
  )

  return { onMenuAction, dialogs }
}

function RenameAgentDialog({
  workspaceSlug,
  target,
  onOpenChange,
}: {
  workspaceSlug: string
  target: { slug: string; name: string } | null
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations('duetApp.agentActions.rename')
  const toast = useToast()
  const rename = useRenameAgent(workspaceSlug)
  const renameDefault = useRenameDefaultAgent(workspaceSlug)
  const [name, setName] = useState('')

  // Pre-fill the field with the current name (an editable value, not a grey
  // placeholder), matching the drive's own rename dialog. Re-seed whenever the
  // dialog opens on a different agent.
  useEffect(() => {
    if (target !== null) setName(target.name)
  }, [target])

  const submit = () => {
    if (target === null) return
    const next = name.trim()
    if (next.length === 0 || next === target.name) {
      onOpenChange(false)
      return
    }
    // Optimistic: the roster name updates in `onMutate` and this dialog closes
    // immediately. A rejected rename rolls the name back and surfaces a toast,
    // rather than trapping the user behind a modal for a control-plane blip.
    // One dialog, two durable owners. The default agent's name is the
    // workspace's `duetName`; every other agent's is a column on its own row.
    // The reserved `root` slug is what lets the two share this form.
    const onError = () => toast({ tone: 'warning', message: t('error', { name: target.name }) })
    if (target.slug === ROOT_AGENT_SCOPE) renameDefault.mutate(next, { onError })
    else rename.mutate({ slug: target.slug, name: next }, { onError })
    onOpenChange(false)
  }

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={event => {
            event.preventDefault()
            submit()
          }}
        >
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="agent-rename-input">
              {t('label')}
            </label>
            <Input
              id="agent-rename-input"
              autoFocus
              value={name}
              onChange={event => setName(event.target.value)}
            />
          </div>
          <DialogFooter className="grid grid-cols-2 gap-2 sm:flex">
            <Button
              type="button"
              variant="outline"
              className="text-foreground"
              onClick={() => onOpenChange(false)}
            >
              {t('cancel')}
            </Button>
            <Button type="submit">{t('save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DeleteAgentDialog({
  workspaceSlug,
  target,
  onOpenChange,
  onDeleted,
}: {
  workspaceSlug: string
  target: { slug: string; name: string } | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}) {
  const t = useTranslations('duetApp.agentActions.delete')
  const del = useDeleteAgent(workspaceSlug)
  const [failure, setFailure] = useState<'gateway' | 'generic' | null>(null)

  const confirm = () => {
    if (target === null) return
    setFailure(null)
    del.mutate(target.slug, {
      onSuccess: () => {
        onOpenChange(false)
        onDeleted?.()
      },
      // Fail-closed: the card and its sessions stay because nothing was
      // invalidated. Keep the dialog open and offer a retry. A 502 means the
      // gateway could not tear the runners down; anything else is generic.
      onError: error => {
        setFailure(error instanceof DuetApiError && error.status === 502 ? 'gateway' : 'generic')
      },
    })
  }

  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={open => {
        if (del.isPending) return
        if (!open) setFailure(null)
        onOpenChange(open)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title', { name: target?.name ?? '' })}</AlertDialogTitle>
          <AlertDialogDescription>{t('description')}</AlertDialogDescription>
        </AlertDialogHeader>
        {failure !== null ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {t(failure === 'gateway' ? 'errorGateway' : 'errorGeneric')}
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={del.isPending}>{t('cancel')}</AlertDialogCancel>
          <Button variant="destructive" onClick={confirm} disabled={del.isPending}>
            {del.isPending ? <SpinnerGapIcon className="mr-2 size-4 animate-spin" /> : null}
            {failure !== null ? t('retry') : t('confirm')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
