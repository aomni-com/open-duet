import { expect, test } from 'bun:test'

import robots from '../app/robots'

test('AI crawlers can reach only the reviewed public prefixes', () => {
  const rules = robots().rules
  expect(Array.isArray(rules)).toBe(true)
  if (!Array.isArray(rules)) throw new Error('Expected one robots rule list')

  const generic = rules.find(rule => rule.userAgent === '*')
  expect(generic?.allow).toBe('/')

  expect(rules.filter(rule => rule.userAgent !== '*').map(rule => rule.userAgent)).toEqual([
    'GPTBot',
    'ChatGPT-User',
    'PerplexityBot',
    'ClaudeBot',
    'OAI-SearchBot',
    'Google-Extended',
  ])

  for (const rule of rules.filter(rule => rule.userAgent !== '*')) {
    expect(rule.allow).toEqual([
      '/guides/',
      '/blog/',
      '/use-cases/',
      '/vs/',
      '/for/',
      '/es/guides/',
      '/es/blog/',
      '/llms.txt',
      '/llms-full.txt',
      '/*.md$',
    ])
    expect(rule.disallow).toContain('/')
    expect(rule.allow).not.toContain('/')
  }
})
