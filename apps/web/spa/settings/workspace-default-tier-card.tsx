'use client'

import { useTranslations } from 'next-intl'

import {
  MODEL_SELECTIONS,
  type ModelSelectionId,
  type WorkspaceRole,
  type WorkspaceSummary,
} from '@repo/contract'
import { QualitySelector } from '@repo/ui/components/quality-selector'

import {
  buildTierQualityOptions,
  buildAdvancedQualityOptions,
} from '../model-tiers/tier-quality-options'
import { SettingsCard } from './settings-frame'

type DefaultTierProjection = WorkspaceSummary['defaultTier']

export function WorkspaceDefaultTierCard({
  projection,
  role,
  pending,
  onChange,
}: {
  projection: DefaultTierProjection
  role: WorkspaceRole
  pending: boolean
  onChange: (tier: ModelSelectionId) => void
}) {
  const t = useTranslations('duetSettings.workspace.general.defaultTier')
  const tierCopy = useTranslations('duetApp.sessionProduct')
  const effectiveLabel = MODEL_SELECTIONS[projection.effective].label
  const scoreLabel = (label: string) =>
    label === 'Performance'
      ? t('performance')
      : label === 'Intelligence'
        ? t('intelligence')
        : t('cost')
  const options = buildTierQualityOptions(
    label => label,
    scoreLabel,
    tier =>
      tierCopy(
        {
          frontier: 'qualityMaxDescription',
          balanced: 'qualityStandardDescription',
          economy: 'qualityEconomyDescription',
        }[tier],
      ),
  )
  const owner = role === 'owner'

  return (
    <div data-default-tier-card>
      <SettingsCard title={t('title')} description={t('description')}>
        <QualitySelector
          label={t('controlLabel')}
          value={projection.effective}
          options={options}
          advanced={{
            label: t('advanced'),
            options: buildAdvancedQualityOptions(scoreLabel),
          }}
          onValueChange={onChange}
          disabled={!owner || pending}
          appearance="settings"
        />
        <div className="mt-4 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="min-w-0 text-sm text-muted-foreground">
            {projection.configured === undefined
              ? t('derived', { effective: effectiveLabel })
              : t('effective', { effective: effectiveLabel })}
          </p>
          {owner ? null : (
            <p className="shrink-0 text-sm text-muted-foreground">{t('ownerOnly')}</p>
          )}
        </div>
      </SettingsCard>
    </div>
  )
}
