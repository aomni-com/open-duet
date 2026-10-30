import { expect, test } from 'bun:test'

import {
  getUseCaseJobs,
  getUseCasePersonas,
  type UseCaseJob,
  type UseCasePersona,
} from '../components/landing/use-cases/use-cases-spec'
import { getComparisons, type Comparison } from '../components/landing/vs/vs-spec'

const ALLOWED_INVARIANT_PROSE = new Set([
  'Bolt.new', // brand
  'Codex', // brand
  'Cursor', // brand
  'Duet', // brand
  'Lovable', // brand
  'Replit', // brand
  'v0', // brand
])

type ProseField = { path: string; value: string }

function fields(path: string, values: Array<[string, string | undefined]>): ProseField[] {
  return values.flatMap(([field, value]) =>
    value === undefined ? [] : [{ path: `${path}.${field}`, value }],
  )
}

function personaProse(persona: UseCasePersona, index: number): ProseField[] {
  const path = `personas[${index}]`
  return [
    ...fields(path, [
      ['name', persona.name],
      ['shortName', persona.shortName],
      ['navLabel', persona.navLabel],
      ['eyebrow', persona.eyebrow],
      ['h1Lead', persona.h1Lead],
      ['h1Highlight', persona.h1Highlight],
      ['metaTitle', persona.metaTitle],
      ['metaDescription', persona.metaDescription],
      ['primaryKeyword', persona.primaryKeyword],
      ['heroDescription', persona.heroDescription],
      ['definition', persona.definition],
      ['primaryCtaLabel', persona.primaryCtaLabel],
    ]),
    ...persona.secondaryKeywords.map((value, item) => ({
      path: `${path}.secondaryKeywords[${item}]`,
      value,
    })),
    ...persona.painCards.flatMap((card, item) =>
      fields(`${path}.painCards[${item}]`, [
        ['title', card.title],
        ['quote', card.quote],
        ['body', card.body],
      ]),
    ),
    ...persona.useCases.flatMap((useCase, item) =>
      fields(`${path}.useCases[${item}]`, [
        ['title', useCase.title],
        ['prompt', useCase.prompt],
        ['outcome', useCase.outcome],
      ]),
    ),
    ...persona.comparison.with.map((value, item) => ({
      path: `${path}.comparison.with[${item}]`,
      value,
    })),
    ...persona.comparison.without.map((value, item) => ({
      path: `${path}.comparison.without[${item}]`,
      value,
    })),
    ...persona.howItWorks.flatMap((step, item) =>
      fields(`${path}.howItWorks[${item}]`, [
        ['title', step.title],
        ['body', step.body],
      ]),
    ),
    ...persona.faqs.flatMap((faq, item) =>
      fields(`${path}.faqs[${item}]`, [
        ['q', faq.q],
        ['a', faq.a],
      ]),
    ),
    ...persona.leaves.flatMap((leaf, item) => {
      const leafPath = `${path}.leaves[${item}]`
      return [
        ...fields(leafPath, [
          ['title', leaf.title],
          ['h1', leaf.h1],
          ['metaTitle', leaf.metaTitle],
          ['metaDescription', leaf.metaDescription],
          ['intro', leaf.intro],
        ]),
        ...leaf.workflowSteps.flatMap((step, stepIndex) =>
          fields(`${leafPath}.workflowSteps[${stepIndex}]`, [
            ['title', step.title],
            ['body', step.body],
          ]),
        ),
        ...leaf.faqs.flatMap((faq, faqIndex) =>
          fields(`${leafPath}.faqs[${faqIndex}]`, [
            ['q', faq.q],
            ['a', faq.a],
          ]),
        ),
      ]
    }),
  ]
}

function jobProse(job: UseCaseJob, index: number): ProseField[] {
  const path = `jobs[${index}]`
  return [
    ...fields(path, [
      ['title', job.title],
      ['h1', job.h1],
      ['metaTitle', job.metaTitle],
      ['metaDescription', job.metaDescription],
      ['intro', job.intro],
    ]),
    ...job.jobSteps.flatMap((step, item) =>
      fields(`${path}.jobSteps[${item}]`, [
        ['title', step.title],
        ['body', step.body],
      ]),
    ),
    ...job.faqs.flatMap((faq, item) =>
      fields(`${path}.faqs[${item}]`, [
        ['q', faq.q],
        ['a', faq.a],
      ]),
    ),
  ]
}

function comparisonProse(comparison: Comparison, index: number): ProseField[] {
  const path = `comparisons[${index}]`
  return [
    ...fields(path, [
      ['competitor', comparison.competitor],
      ['metaTitle', comparison.metaTitle],
      ['metaDescription', comparison.metaDescription],
      ['h1', comparison.h1],
      ['lastChanged', comparison.lastChanged],
      ['verdict.tldr', comparison.verdict.tldr],
    ]),
    ...comparison.verdict.matrix.flatMap((row, item) =>
      fields(`${path}.verdict.matrix[${item}]`, [
        ['ifYoure', row.ifYoure],
        ['bestFit', row.bestFit],
      ]),
    ),
    ...comparison.atAGlance.flatMap((row, item) =>
      fields(`${path}.atAGlance[${item}]`, [
        ['capability', row.capability],
        ['competitorNote', row.competitorNote],
        ['duetNote', row.duetNote],
      ]),
    ),
    ...comparison.whereCompetitorWins.flatMap((block, item) =>
      fields(`${path}.whereCompetitorWins[${item}]`, [
        ['heading', block.heading],
        ['body', block.body],
      ]),
    ),
    ...comparison.whereDuetWins.flatMap((block, item) =>
      fields(`${path}.whereDuetWins[${item}]`, [
        ['heading', block.heading],
        ['body', block.body],
      ]),
    ),
    ...comparison.pricingScenarios.flatMap((scenario, item) =>
      fields(`${path}.pricingScenarios[${item}]`, [
        ['scenario', scenario.scenario],
        ['competitorCost', scenario.competitorCost],
        ['duetCost', scenario.duetCost],
      ]),
    ),
    ...(comparison.migration
      ? [
          ...fields(`${path}.migration`, [
            ['intro', comparison.migration.intro],
            ['guideLabel', comparison.migration.guideLabel],
          ]),
          ...comparison.migration.steps.flatMap((step, item) =>
            fields(`${path}.migration.steps[${item}]`, [
              ['title', step.title],
              ['body', step.body],
            ]),
          ),
        ]
      : []),
    ...comparison.howToChoose.flatMap((row, item) =>
      fields(`${path}.howToChoose[${item}]`, [
        ['persona', row.persona],
        ['recommendation', row.recommendation],
      ]),
    ),
    ...comparison.faqs.flatMap((faq, item) =>
      fields(`${path}.faqs[${item}]`, [
        ['q', faq.q],
        ['a', faq.a],
      ]),
    ),
  ]
}

function expectLocalizedProse(english: ProseField[], spanish: ProseField[]): void {
  expect(spanish.map(field => field.path)).toEqual(english.map(field => field.path))

  const untranslated = spanish.flatMap((field, index) =>
    field.value === english[index]?.value && !ALLOWED_INVARIANT_PROSE.has(field.value)
      ? [`${field.path}: ${JSON.stringify(field.value)}`]
      : [],
  )
  expect(untranslated).toEqual([])
}

test('Spanish locale specs do not inherit English prose', () => {
  expectLocalizedProse(
    getUseCasePersonas('en').flatMap(personaProse),
    getUseCasePersonas('es-419').flatMap(personaProse),
  )
  expectLocalizedProse(
    getUseCaseJobs('en').flatMap(jobProse),
    getUseCaseJobs('es-419').flatMap(jobProse),
  )
  expectLocalizedProse(
    getComparisons('en').flatMap(comparisonProse),
    getComparisons('es-419').flatMap(comparisonProse),
  )
})
