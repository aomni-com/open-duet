import {
  MODEL_SELECTIONS,
  ModelSelectionIdSchema,
  type RecordedAttributionTierId,
} from '@repo/contract'

export function UsageTierBadge({ tier }: { tier: RecordedAttributionTierId }) {
  const selection = ModelSelectionIdSchema.safeParse(tier)
  const label = selection.success ? MODEL_SELECTIONS[selection.data].label : tier
  return (
    <span
      data-usage-tier={label}
      className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary"
    >
      {label}
    </span>
  )
}
