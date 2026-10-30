import { describe, expect, test } from 'bun:test'

import {
  deriveFixtureCoverage,
  deriveRouteCoverage,
  inventoryMdxImports,
  inventoryPageModules,
  inventoryRuntimeImports,
  inventoryVisualSymbols,
  matchNextPage,
  validateCoverage,
} from '../../../scripts/visual-coverage-core'

describe('visual coverage validation', () => {
  test('rejects a rendered symbol with no exact owner', () => {
    expect(
      validateCoverage({
        inventory: ['components/session-card.tsx#SessionCard'],
        fixtures: ['session-card'],
        entries: [],
      }),
    ).toEqual(['missing coverage: components/session-card.tsx#SessionCard'])
  })

  test('inventories exported arrow-function components', () => {
    expect(
      inventoryVisualSymbols(
        'components/session-card.tsx',
        `export const SessionCard = () => <article>Session</article>`,
      ),
    ).toEqual(['components/session-card.tsx#SessionCard'])
  })

  test('inventories components wrapped in memo and forwardRef', () => {
    expect(
      inventoryVisualSymbols(
        'components/buttons.tsx',
        `
          import { forwardRef, memo } from 'react'

          export const PrimaryButton = forwardRef<HTMLButtonElement, object>(
            (props, ref) => <button ref={ref}>Primary</button>,
          )
          export const SecondaryButton = memo(function SecondaryButton() {
            return <button>Secondary</button>
          })
          export const IconButton = memo(
            forwardRef<HTMLButtonElement, object>((props, ref) => (
              <button ref={ref}>Icon</button>
            )),
          )
        `,
      ),
    ).toEqual([
      'components/buttons.tsx#IconButton',
      'components/buttons.tsx#PrimaryButton',
      'components/buttons.tsx#SecondaryButton',
    ])
  })

  test('inventories component exports whose implementation is delegated', () => {
    expect(
      inventoryVisualSymbols(
        'components/primitives.tsx',
        `
          import * as Primitive from '@radix-ui/react-dialog'
          const Internal = () => <div>Internal</div>
          const Dialog = Primitive.Root
          const SiriOrbComponent = () => <canvas />
          type VisualState = { ready: boolean }
          export { Dialog, SiriOrbComponent as SiriOrb }
          export { type VisualState }
          export default class ErrorBoundary extends React.Component {}
        `,
      ),
    ).toEqual([
      'components/primitives.tsx#Dialog',
      'components/primitives.tsx#ErrorBoundary',
      'components/primitives.tsx#Internal',
      'components/primitives.tsx#SiriOrb',
      'components/primitives.tsx#SiriOrbComponent',
    ])
  })

  test('inventories anonymous default components and every page module', () => {
    expect(
      inventoryVisualSymbols(
        'components/anonymous.tsx',
        `export default () => <main>Anonymous</main>`,
      ),
    ).toEqual(['components/anonymous.tsx#default'])
    expect(
      inventoryPageModules([
        'app/page.mdx',
        'app/[locale]/page.tsx',
        'app/api/route.ts',
        'components/page.tsx',
      ]),
    ).toEqual([
      'app/[locale]/page.tsx#page-module',
      'app/page.mdx#page-module',
      'components/page.tsx#page-module',
    ])
  })

  test('prefers a static page over a matching dynamic page', () => {
    expect(
      matchNextPage('/en/for/insurance-agents', [
        'app/[locale]/for/[vertical]/page.tsx',
        'app/[locale]/for/insurance-agents/page.tsx',
      ]),
    ).toBe('app/[locale]/for/insurance-agents/page.tsx')
  })

  test('inventories static and dynamic runtime imports but not type-only imports', () => {
    expect(
      inventoryRuntimeImports(`
        import { Hero } from '@/components/hero'
        import type { HeroProps } from '@/components/hero-types'
        export { Footer } from './footer'
        const Dialog = dynamic(() => import('./dialog').then(module => module.Dialog))
      `),
    ).toEqual(['./dialog', './footer', '@/components/hero'])
  })

  test('inventories runtime imports from MDX without parsing prose', () => {
    expect(
      inventoryMdxImports(`
        import { EndpointReference } from '../../components/endpoint-reference'
        export const metadata = { title: 'Reference' }

        # API reference
        <EndpointReference />
      `),
    ).toEqual(['../../components/endpoint-reference'])
  })

  test('derives route ownership only through a concrete page import closure', () => {
    expect(
      deriveRouteCoverage({
        symbolsByFile: new Map([
          ['app/[locale]/page.tsx', ['app/[locale]/page.tsx#Page']],
          ['components/hero.tsx', ['components/hero.tsx#Hero']],
          ['components/orphan.tsx', ['components/orphan.tsx#Orphan']],
        ]),
        dependenciesByFile: new Map([
          ['app/[locale]/page.tsx', ['components/hero.tsx']],
          ['components/hero.tsx', []],
          ['components/orphan.tsx', []],
        ]),
        routeRoots: [{ route: '/', files: ['app/[locale]/page.tsx'] }],
      }),
    ).toEqual([
      { target: 'app/[locale]/page.tsx#Page', kind: 'owned-by', owner: 'route:/' },
      { target: 'components/hero.tsx#Hero', kind: 'owned-by', owner: 'route:/' },
    ])
  })

  test('derives fixture ownership through the fixture component import closure', () => {
    expect(
      deriveFixtureCoverage({
        symbolsByFile: new Map([
          ['components/playground.tsx', ['components/playground.tsx#Playground']],
          ['packages/ui/src/button.tsx', ['packages/ui/src/button.tsx#Button']],
        ]),
        dependenciesByFile: new Map([
          ['components/playground.tsx', ['packages/ui/src/button.tsx']],
          ['packages/ui/src/button.tsx', []],
        ]),
        fixtureRoots: [{ fixture: 'ui-primitives', files: ['components/playground.tsx'] }],
      }),
    ).toEqual([
      {
        target: 'components/playground.tsx#Playground',
        kind: 'owned-by',
        owner: 'fixture:ui-primitives',
      },
      {
        target: 'packages/ui/src/button.tsx#Button',
        kind: 'owned-by',
        owner: 'fixture:ui-primitives',
      },
    ])
  })

  test('rejects ownership assigned to a route outside the screenshot suite', () => {
    expect(
      validateCoverage({
        inventory: ['components/hero.tsx#Hero'],
        fixtures: [],
        routes: ['/'],
        entries: [
          {
            target: 'components/hero.tsx#Hero',
            kind: 'owned-by',
            owner: 'route:/not-captured',
          },
        ],
      }),
    ).toEqual(['unknown route owner /not-captured for components/hero.tsx#Hero'])
  })
})
