import { describe, expect, it } from 'bun:test'

import { extractHeadings } from '../lib/blog/toc'

describe('blog table-of-contents slugs', () => {
  it('matches rehype-slug for repeated and already-suffixed headings', () => {
    const headings = extractHeadings(`
## Instructions
### Examples
## Instructions
### Examples
## Instructions-1
## Instructions
`)

    expect(headings.map(heading => heading.id)).toEqual([
      'instructions',
      'examples',
      'instructions-1',
      'examples-1',
      'instructions-1-1',
      'instructions-2',
    ])
  })
})
