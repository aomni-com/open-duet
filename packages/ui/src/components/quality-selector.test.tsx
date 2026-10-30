import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { QualitySelector, type QualitySelectorOption } from './quality-selector'
import { TooltipProvider } from './shadcn/tooltip'

const qualityOptions = [
  {
    id: 'balanced',
    label: 'Standard',
    detail: 'Routes each task to leading models.',
    scores: { performance: 4, intelligence: 4, cost: 3 },
    scoreLabels: {
      performance: 'Performance',
      intelligence: 'Intelligence',
      cost: 'Cost',
    },
  },
  {
    id: 'frontier',
    label: 'Max',
    scores: { performance: 3, intelligence: 5, cost: 5 },
    scoreLabels: {
      performance: 'Performance',
      intelligence: 'Intelligence',
      cost: 'Cost',
    },
  },
] as const satisfies readonly QualitySelectorOption[]

test('renders a compact settings trigger instead of an inline quality scale', () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <QualitySelector
        label="Default quality"
        value="balanced"
        options={qualityOptions}
        onValueChange={() => undefined}
        appearance="settings"
      />
    </TooltipProvider>,
  )

  expect(html).toContain('Default quality: </span>')
  expect(html).toContain('>Standard</span>')
  expect(html).toContain('aria-label="Performance: 4/5"')
  expect(html).toContain('aria-label="Intelligence: 4/5"')
  expect(html).toContain('aria-label="Cost: 3/5"')
  expect(html).not.toContain('role="radiogroup"')
})

test('keeps the compose trigger label and selected quality in its gradient row', () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <QualitySelector
        label="Quality"
        value="balanced"
        options={qualityOptions}
        onValueChange={() => undefined}
        appearance="compose"
      />
    </TooltipProvider>,
  )

  expect(html).toContain('Quality: </span>')
  expect(html).toContain('>Quality:</span>')
  expect(html).toContain('aria-label="Performance: 4/5"')
  expect(html).toContain('aria-label="Intelligence: 4/5"')
  expect(html).toContain('aria-label="Cost: 3/5"')
  expect(html).not.toContain('role="radiogroup"')
})

test('shows the selected advanced label and supplied scores without its backing-model detail', () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <QualitySelector
        label="Quality"
        value="specialist"
        options={qualityOptions}
        advanced={{
          label: 'Advanced',
          options: [
            {
              id: 'specialist',
              label: 'Specialist',
              detail: 'Current model version',
              scores: { performance: 2, intelligence: 5, cost: 5 },
              scoreLabels: {
                performance: 'Performance',
                intelligence: 'Intelligence',
                cost: 'Cost',
              },
            },
          ],
        }}
        onValueChange={() => undefined}
        appearance="compose"
      />
    </TooltipProvider>,
  )

  expect(html).toContain('>Specialist</span>')
  expect(html).not.toContain('Current model version')
  expect(html).toContain('aria-label="Performance: 2/5"')
  expect(html).toContain('aria-label="Intelligence: 5/5"')
  expect(html).toContain('aria-label="Cost: 5/5"')
})
