import { describe, expect, test } from 'bun:test'

import {
  createApprovedModelCatalog,
  renderModelsReference,
  type ApprovedModel,
} from '@repo/contract'

import { buildSkillsBundle } from './bundle'
import { renderDefaultSkills, renderSkills } from './render'

const fixtureModel: ApprovedModel = {
  id: 'fixture:chat',
  gatewayModelId: 'fixture/chat',
  kind: 'chat',
  name: 'Fixture chat',
  simpleName: 'fixture',
  description: 'Synthetic model for registry tests',
  internal: true,
}

function fixtureCatalog(model: ApprovedModel = fixtureModel) {
  return createApprovedModelCatalog([model])
}

describe('renderSkills', () => {
  test('substitutes the app URL and injects the catalog-owned models reference', () => {
    const catalog = fixtureCatalog()
    const files = renderSkills({
      appUrl: 'https://fixture.test/workspace',
      catalog,
      skills: [{ path: 'fixture/SKILL.md', content: 'Open {{APP_URL}}/settings.\n' }],
    })

    expect(files).toEqual([
      {
        path: 'fixture/SKILL.md',
        content: 'Open https://fixture.test/workspace/settings.\n',
      },
      {
        path: 'media-creation/reference/models.json',
        content: renderModelsReference(catalog),
      },
    ])
  })

  test('rejects unresolved placeholders in fixture skills', () => {
    expect(() =>
      renderSkills({
        appUrl: 'https://fixture.test',
        catalog: fixtureCatalog(),
        skills: [{ path: 'fixture/SKILL.md', content: 'Unknown: {{NOPE}}\n' }],
      }),
    ).toThrow(/unresolved placeholder \{\{NOPE\}\}.*fixture\/SKILL\.md/i)
  })

  test('changes the bundle hash when the app URL or catalog changes', () => {
    const skills = [{ path: 'fixture/SKILL.md', content: 'Open {{APP_URL}}.\n' }]
    const render = (appUrl: string, model: ApprovedModel = fixtureModel) =>
      buildSkillsBundle(renderSkills({ appUrl, catalog: fixtureCatalog(model), skills }))
    const original = render('https://one.fixture.test')

    expect(render('https://two.fixture.test').hash).not.toBe(original.hash)
    expect(
      render('https://one.fixture.test', {
        ...fixtureModel,
        gatewayModelId: 'fixture/repointed-chat',
      }).hash,
    ).not.toBe(original.hash)
  })
})

test('default skills do not direct agents to retired Crustdata endpoints', () => {
  const files = renderDefaultSkills({ appUrl: 'https://fixture.test', catalog: fixtureCatalog() })
  const retired = files.filter(file => /\/screener\//.test(file.content)).map(file => file.path)
  expect(retired).toEqual([])
})
