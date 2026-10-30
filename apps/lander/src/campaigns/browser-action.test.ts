import { describe, expect, it } from 'bun:test'

import { buildEmailLeadRequest } from './browser-action'

describe('browser campaign actions', () => {
  it('keeps lead metadata in generic data and carries no campaign attribution', () => {
    expect(
      buildEmailLeadRequest({
        email: 'owner@example.com',
        source: 'growth-form',
        pageSlug: 'grow',
        company: { name: 'Acme', url: 'https://acme.test' },
        sourceUrl:
          'https://lander.test/grow?utm_source=reddit&fbclid=meta&oppref=partner&unknown=nope',
        referrer: 'https://search.example/results',
      }),
    ).toEqual({
      data: {
        email: 'owner@example.com',
        source: 'growth-form',
        pageSlug: 'grow',
        company: { name: 'Acme', url: 'https://acme.test' },
      },
    })
  })
})
