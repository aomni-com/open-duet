import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'

import { Markdown } from '@repo/ui/components/common/markdown'

import appEn from '../../messages/en/app.json'
import { createSessionAuthorDirectory } from './session-authors'
import { SessionMarkdown } from './session-markdown'
import { SessionTimeline } from './session-message'

test('a skill tag in a sent message reads as the chip the composer showed', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SessionMarkdown
        text={'<Skill name="review" path="/skills/review" /> before the release goes out'}
        cwd={undefined}
        workspaceSlug="acme"
        fileUrl={drivePath => `/files/${drivePath}`}
      />
    </MemoryRouter>,
  )

  // The renderer drops raw HTML rather than escaping it, so without a transform
  // the skill vanishes from the reader's own message and leaves no trace.
  expect(html).toContain('data-session-skill')
  expect(html).toContain('/review')
  expect(html).toContain('before the release goes out')
  expect(html).not.toContain('&lt;Skill')
})

test('a message that merely talks about a tag is left alone', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SessionMarkdown
        text={'use `<Skill name="review" />` to invoke it'}
        cwd={undefined}
        workspaceSlug="acme"
        fileUrl={drivePath => `/files/${drivePath}`}
      />
    </MemoryRouter>,
  )

  expect(html).toContain('<code')
  expect(html).not.toContain('data-session-skill')
  // The quoted grammar has to survive verbatim, not come back as link syntax:
  // "how do I invoke a skill" is a message this product will actually carry.
  expect(html).toContain('&lt;Skill name=&quot;review&quot; /&gt;')
})

test('a stray backtick cannot make a skill disappear', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SessionMarkdown
        text={'don`t worry — <Skill name="review" path="/skills/review" /> this'}
        cwd={undefined}
        workspaceSlug="acme"
        fileUrl={drivePath => `/files/${drivePath}`}
      />
    </MemoryRouter>,
  )

  // An unmatched backtick must not flip the rest of the line into "code" and
  // suppress the chip — the renderer drops the raw tag, so the skill would
  // vanish silently, which is the bug this transform exists to prevent.
  expect(html).toContain('data-session-skill')
})

test('resolves a cwd-relative image through the authenticated file URL seam', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SessionMarkdown
        text="![Quarterly chart](chart.png)"
        cwd="reports/q2"
        workspaceSlug="acme"
        fileUrl={drivePath => `/files/${drivePath}`}
      />
    </MemoryRouter>,
  )

  expect(html).toContain('<img')
  expect(html).toContain('src="/files/reports/q2/chart.png"')
})

test('resolves user and agent text through the same session media owner', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <SessionTimeline
          messages={[
            {
              id: 'user',
              role: 'input',
              source: 'prompt',
              sender: { kind: 'user', userId: 'user_ada' },
              text: '![User chart](chart.png)',
            },
            {
              id: 'agent',
              role: 'agent',
              finalized: true,
              parts: [{ kind: 'text', id: 'text', text: '![Agent chart](chart.png)' }],
            },
          ]}
          duetName="Duet"
          authors={createSessionAuthorDirectory({})}
          imageUrl={() => 'about:blank'}
          cwd="reports/q2"
          workspaceSlug="acme"
          fileUrl={drivePath => `/files/${drivePath}`}
        />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )

  expect(html.match(/src="\/files\/reports\/q2\/chart\.png"/g)).toHaveLength(2)
})

test('an agent mention chips in both directions and points at that agent', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <SessionTimeline
          messages={[
            {
              id: 'user',
              role: 'input',
              source: 'prompt',
              sender: { kind: 'user', userId: 'user_ada' },
              text: 'have <Agent name="Scout" slug="scout" /> take it',
            },
            {
              id: 'agent',
              role: 'agent',
              finalized: true,
              parts: [
                {
                  kind: 'text',
                  id: 'text',
                  text: 'passing it to <Agent name="Scout" slug="scout-web" />',
                },
              ],
            },
          ]}
          duetName="Duet"
          authors={createSessionAuthorDirectory({})}
          imageUrl={() => 'about:blank'}
          cwd="reports/q2"
          workspaceSlug="acme"
          fileUrl={drivePath => `/files/${drivePath}`}
        />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )

  // One transform serves the sender's own message and the agent's reply, so a
  // colleague named by either side reads the same way.
  expect(html.match(/data-session-agent/g)).toHaveLength(2)
  // Same display name, different colleagues: the slug is what the link carries.
  expect(html).toContain('href="/w/acme/agents/scout"')
  expect(html).toContain('href="/w/acme/agents/scout-web"')
  expect(html).not.toContain('&lt;Agent')
})

test('an agent mention without a workspace to point at still reads as a chip', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SessionMarkdown
        text={'ask <Agent name="Scout" slug="scout" />'}
        cwd={undefined}
        workspaceSlug={undefined}
        fileUrl={drivePath => `/files/${drivePath}`}
      />
    </MemoryRouter>,
  )

  expect(html).toContain('data-session-agent')
  expect(html).toContain('@Scout')
  expect(html).not.toContain('href="/w/')
})

test('keeps a remote file link on the ordinary link behavior', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SessionMarkdown
        text="[Remote report](https://example.test/report.pdf)"
        cwd="reports/q2"
        workspaceSlug="acme"
        fileUrl={drivePath => `/files/${drivePath}`}
      />
    </MemoryRouter>,
  )

  expect(html).toContain('href="https://example.test/report.pdf"')
  expect(html).not.toContain('data-session-file-card')
})

test.each([
  {
    name: 'nested cwd image',
    markdown: '![Plot](assets/plot.png)',
    expectedElement: '<img',
    expectedUrl: 'src="/files/projects/demo/assets/plot.png"',
  },
  {
    name: 'video',
    markdown: '![Demo](clips/demo.mp4)',
    expectedElement: '<video',
    expectedUrl: 'src="/files/projects/demo/clips/demo.mp4"',
  },
  {
    name: 'audio',
    markdown: '![Narration](audio/recap.ogg)',
    expectedElement: '<audio',
    expectedUrl: 'src="/files/projects/demo/audio/recap.ogg"',
  },
  {
    name: 'remote image',
    markdown: '![Remote](https://media.example.test/chart.webp)',
    expectedElement: '<img',
    expectedUrl: 'src="https://media.example.test/chart.webp"',
  },
  {
    name: 'non-media embed fallback',
    markdown: '![Appendix](appendix.pdf)',
    expectedElement: 'data-session-file-card="true"',
    expectedUrl: 'href="/files/projects/demo/appendix.pdf"',
  },
  {
    name: 'PDF file link',
    markdown: '[Release report](release.pdf)',
    expectedElement: 'data-session-file-card="true"',
    expectedUrl: 'href="/files/projects/demo/release.pdf"',
  },
  {
    name: 'unknown-extension file link',
    markdown: '[Model artifact](model.weights)',
    expectedElement: 'data-session-file-card="true"',
    expectedUrl: 'href="/files/projects/demo/model.weights"',
  },
  {
    name: 'encoded-space file',
    markdown: '![Final plot](final%20plot.png)',
    expectedElement: '<img',
    expectedUrl: 'src="/files/projects/demo/final%20plot.png"',
  },
  {
    name: 'outside-drive absolute file',
    markdown: '[Host secret](/etc/secret.txt)',
    expectedElement: 'data-session-file-card="true"',
    expectedUrl: 'href="/files//etc/secret.txt"',
  },
] as const)('renders $name with the resolved element and URL', row => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SessionMarkdown
        text={row.markdown}
        cwd="projects/demo"
        workspaceSlug="acme"
        fileUrl={drivePath => `/files/${drivePath}`}
      />
    </MemoryRouter>,
  )

  expect(html).toContain(row.expectedElement)
  expect(html).toContain(row.expectedUrl)
})

test('keeps extensionless product paths as ordinary links', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SessionMarkdown
        text="[Research agent](/w/acme/agents/research)"
        cwd="projects/demo"
        workspaceSlug="acme"
        fileUrl={drivePath => `/files/${drivePath}`}
      />
    </MemoryRouter>,
  )

  expect(html).toContain('href="/w/acme/agents/research"')
  expect(html).not.toContain('data-session-file-card')
})

test('keeps literal percent escapes in logical Drive filenames', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SessionMarkdown
        text="![Not a PDF](report%2Epdf)"
        cwd="projects/demo"
        workspaceSlug="acme"
        fileUrl={drivePath => `/files/${drivePath}`}
      />
    </MemoryRouter>,
  )

  expect(html).toContain('OTHER · projects/demo/report%2Epdf')
  expect(html).not.toContain('PDF ·')
})

test('enables native controls and inline playback on embedded media', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SessionMarkdown
        text={'![Walkthrough](demo.webm)\n\n![Recap](recap.wav)'}
        cwd="projects/demo"
        workspaceSlug="acme"
        fileUrl={drivePath => `/files/${drivePath}`}
      />
    </MemoryRouter>,
  )

  expect(html).toMatch(/<video[^>]*controls=""[^>]*playsInline=""/)
  expect(html).toMatch(/<audio[^>]*controls=""/)
})

test('keeps raw HTML inert', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SessionMarkdown
        text={'Before <video src="https://evil.example/video.mp4" autoplay></video> after'}
        cwd={undefined}
        workspaceSlug="acme"
        fileUrl={drivePath => `/files/${drivePath}`}
      />
    </MemoryRouter>,
  )

  expect(html).not.toContain('<video')
  expect(html).not.toContain('evil.example')
})

test('does not change Markdown consumers that omit component overrides', () => {
  const html = renderToStaticMarkup(<Markdown>![Chart](chart.png)</Markdown>)

  expect(html).toBe(
    '<link rel="preload" as="image" href="chart.png"/><div class="ui-markdown prose break-words dark:prose-invert prose-p:leading-normal prose-a:no-underline prose-pre:p-0 max-w-full"><p class="last:!mb-0 whitespace-pre-wrap break-words"><img src="chart.png" alt="Chart"/></p></div>',
  )
})

/* A link is agent-authored text, and naming the file it points at is part of
   RENDERING it — so a path the drive cannot address used to throw inside the
   render pass and take the whole destination down with it, error boundary and
   all. A link nobody can follow is a link; it is not a broken page. */
test('a link the drive cannot address stays a link instead of failing the render', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SessionMarkdown
        text={
          'see [the notes](../../../outside/notes.md) and ' +
          '[the skill](/home/exedev/.duet/skills/github/SKILL.md)'
        }
        cwd={'projects/demo'}
        workspaceSlug="acme"
        fileUrl={drivePath => `/files/${drivePath}`}
      />
    </MemoryRouter>,
  )

  expect(html).toContain('the notes')
  expect(html).toContain('the skill')
  expect(html).not.toContain('data-session-file-card')

  // Same for the media grammar, whose non-media fallback is the same card.
  const media = renderToStaticMarkup(
    <MemoryRouter>
      <SessionMarkdown
        text={'![notes](../../../outside/notes.md)'}
        cwd={'projects/demo'}
        workspaceSlug="acme"
        fileUrl={drivePath => `/files/${drivePath}`}
      />
    </MemoryRouter>,
  )
  expect(media).toContain('notes')
})
