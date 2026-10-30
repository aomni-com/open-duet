import { describe, expect, test } from 'bun:test'

import {
  agentChipSlug,
  skillChipName,
  withMentionChips,
  AGENT_CHIP_SCHEME,
} from './session-mention-chips'

describe('withMentionChips', () => {
  test('an agent tag becomes a chip link carrying the slug', () => {
    expect(withMentionChips('have <Agent name="Scout" slug="scout" /> look at it')).toBe(
      'have [@Scout](#duet-agent=scout) look at it',
    )
  })

  test('an agent with no name of its own is named by its slug', () => {
    expect(withMentionChips('<Agent slug="web-clipper" />')).toBe(
      '[@web-clipper](#duet-agent=web-clipper)',
    )
  })

  test('colleagues sharing a name still link to different agents', () => {
    const rendered = withMentionChips(
      '<Agent name="Scout" slug="scout" /> and <Agent name="Scout" slug="scout-web" />',
    )

    expect(rendered).toBe('[@Scout](#duet-agent=scout) and [@Scout](#duet-agent=scout-web)')
    expect(agentChipSlug('#duet-agent=scout-web')).toBe('scout-web')
  })

  test('both kinds of tag survive on one line, each as its own chip', () => {
    expect(
      withMentionChips('<Skill name="review" path="/s/review" /> with <Agent slug="scout" />'),
    ).toBe('[/review](#duet-skill=review) with [@scout](#duet-agent=scout)')
  })

  test('a bracket in a name cannot cut the link short', () => {
    // Names stored before the schema forbade brackets still have to render as
    // text rather than as broken Markdown.
    expect(withMentionChips('<Agent name="Scout [beta]" slug="scout" />')).toBe(
      '[@Scout \\[beta\\]](#duet-agent=scout)',
    )
  })

  test('a message about the tag keeps the tag', () => {
    const fenced = ['```', '<Agent slug="scout" />', '```'].join('\n')

    expect(withMentionChips(fenced)).toBe(fenced)
    expect(withMentionChips('write `<Agent slug="scout" />` to name it')).toBe(
      'write `<Agent slug="scout" />` to name it',
    )
  })

  test('an opening that closes nothing stays prose', () => {
    expect(withMentionChips('a <Agent slug="scout" without an end')).toBe(
      'a <Agent slug="scout" without an end',
    )
  })

  test('a longer tag name is not mistaken for this one', () => {
    expect(withMentionChips('<AgentRoster slug="scout" />')).toBe('<AgentRoster slug="scout" />')
  })

  test('a slug needing escaping survives the round trip', () => {
    const rendered = withMentionChips('<Agent slug="a b" />')

    expect(rendered).toBe('[@a b](#duet-agent=a%20b)')
    expect(agentChipSlug(rendered.slice(rendered.indexOf(AGENT_CHIP_SCHEME), -1))).toBe('a b')
  })
})

describe('chip link readers', () => {
  test('each reader claims only its own scheme', () => {
    expect(skillChipName('#duet-skill=review')).toBe('review')
    expect(skillChipName('#duet-agent=scout')).toBeNull()
    expect(agentChipSlug('#duet-agent=scout')).toBe('scout')
    expect(agentChipSlug('#duet-skill=review')).toBeNull()
    expect(agentChipSlug('https://example.com')).toBeNull()
  })
})
