import { Badge } from '@repo/ui/components/shadcn/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipTrigger,
} from '@repo/ui/components/shadcn/tooltip'
import { cn } from '@repo/ui/lib/utils'

type Props = {
  tooltipLabel?: string
  className?: string
}

const GenericLabel =
  'Beta features are still in development and may change in the near future and could display unexpected behavior.'

export function BetaBadge({ tooltipLabel = GenericLabel, className }: Props) {
  return (
    <Tooltip>
      <TooltipTrigger>
        <Badge
          className={cn(
            'h-4 bg-blue-500 px-1.5 text-[0.7rem] text-white hover:bg-blue-500 ',
            className,
          )}
        >
          Beta
        </Badge>
      </TooltipTrigger>

      <TooltipPortal>
        <TooltipContent className="max-w-md text-center">{tooltipLabel}</TooltipContent>
      </TooltipPortal>
    </Tooltip>
  )
}
