import {
  MODEL_TIERS,
  MODEL_TIER_IDS,
  PROVIDER_MODEL_ALIASES,
  type ModelTierId,
  type ProviderModelAliasId,
  type ModelTier,
} from '@repo/contract'
import type { QualitySelectorOption } from '@repo/ui/components/quality-selector'

type ScoreLabel = 'Performance' | 'Intelligence' | 'Cost'

export function buildTierQualityOptions(
  formatLabel: (label: ModelTier['label']) => string = label => label,
  formatScoreLabel: (label: ScoreLabel) => string = label => label,
  formatDescription: (tier: ModelTierId) => string = tier => MODEL_TIERS[tier].description,
): readonly QualitySelectorOption<ModelTierId>[] {
  return MODEL_TIER_IDS.map(id => {
    const tier = MODEL_TIERS[id]
    return {
      id,
      label: formatLabel(tier.label),
      detail: formatDescription(id),
      ...qualityScorePresentation(tier.scores, formatScoreLabel),
    }
  })
}

export function buildAdvancedQualityOptions(
  formatScoreLabel: (label: ScoreLabel) => string = label => label,
): readonly QualitySelectorOption<ProviderModelAliasId>[] {
  return Object.values(PROVIDER_MODEL_ALIASES).map(model => {
    return {
      id: model.id,
      label: model.label,
      detail: model.modelLabel,
      ...qualityScorePresentation(model.scores, formatScoreLabel),
    }
  })
}

function qualityScorePresentation(
  scores: ModelTier['scores'],
  formatLabel: (label: ScoreLabel) => string,
) {
  return {
    scores: { performance: scores.speed, intelligence: scores.intelligence, cost: scores.cost },
    scoreLabels: {
      performance: formatLabel('Performance'),
      intelligence: formatLabel('Intelligence'),
      cost: formatLabel('Cost'),
    },
  }
}
