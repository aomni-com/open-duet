import { describe, expect, test } from 'bun:test'

import { renderBuildingPage } from './building-page'

describe('renderBuildingPage', () => {
  test('escapes app names and file paths before inserting them into HTML', () => {
    const html = renderBuildingPage({
      name: `<script>alert("name")</script> & '`,
      files: [{ path: `src/<dangerous data-title="path">'&.ts`, mtimeMs: 1_000 }],
      nowMs: 5_000,
      refreshSeconds: 3,
    })

    expect(html).toContain(
      `&lt;script&gt;alert(&quot;name&quot;)&lt;/script&gt; &amp; &#39;</span> is being built`,
    )
    expect(html).toContain(`src/&lt;dangerous data-title=&quot;path&quot;&gt;&#39;&amp;.ts`)
    expect(html).not.toContain(`<script>alert("name")</script>`)
    expect(html).not.toContain(`<dangerous data-title="path">`)
  })

  test('labels file ages deterministically across seconds and minutes boundaries', () => {
    const nowMs = 300_000
    const html = renderBuildingPage({
      name: 'Analytics',
      files: [
        { path: 'now.ts', mtimeMs: nowMs },
        { path: 'seconds.ts', mtimeMs: nowMs - 59_999 },
        { path: 'one-minute.ts', mtimeMs: nowMs - 60_000 },
        { path: 'two-minutes.ts', mtimeMs: nowMs - 120_000 },
      ],
      nowMs,
      refreshSeconds: 3,
    })

    expect(html).toContain('now.ts</span><time>0s ago</time>')
    expect(html).toContain('seconds.ts</span><time>59s ago</time>')
    expect(html).toContain('one-minute.ts</span><time>1m ago</time>')
    expect(html).toContain('two-minutes.ts</span><time>2m ago</time>')
  })

  test('refreshes using the interval supplied by the caller', () => {
    const html = renderBuildingPage({
      name: 'Analytics',
      files: [],
      nowMs: 0,
      refreshSeconds: 7,
    })

    expect(html).toContain('<meta http-equiv="refresh" content="7">')
  })

  test('emits the reduced-motion rule for the shimmer placeholder', () => {
    const html = renderBuildingPage({
      name: 'Analytics',
      files: [],
      nowMs: 0,
      refreshSeconds: 3,
    })

    expect(html).toContain('@media (prefers-reduced-motion: reduce)')
    expect(html).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation:\s*none/)
  })

  test('omits the recent-activity list when there are no files', () => {
    const html = renderBuildingPage({
      name: 'fresh-app',
      files: [],
      nowMs: 0,
      refreshSeconds: 3,
    })

    expect(html).toContain('>fresh-app</span> is being built')
    expect(html).not.toContain('<section class="activity"')
    expect(html).not.toContain('<ul>')
  })

  test('is self-contained without scripts or remote assets', () => {
    const html = renderBuildingPage({
      name: 'Analytics',
      files: [{ path: 'server.ts', mtimeMs: 0 }],
      nowMs: 4_000,
      refreshSeconds: 3,
    })

    expect(html).not.toMatch(/<script(?:\s|>)/i)
    expect(html).not.toMatch(/https?:\/\//i)
  })
})
