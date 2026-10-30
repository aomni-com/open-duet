import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { AgentAvatar, createAgentAvatarDataUri } from './agent-avatar'

test('creates deterministic local avatars from the canonical avatar key', () => {
  const research = createAgentAvatarDataUri('Research Agent')

  expect(research).toStartWith('data:image/svg+xml')
  expect(createAgentAvatarDataUri(' research-agent ')).toBe(research)
  expect(createAgentAvatarDataUri('Finance Agent')).not.toBe(research)
  expect(research).not.toContain('api.dicebear.com')
})

test('keeps Duet on authored art while other agents use the canonical fallback', () => {
  const html = renderToStaticMarkup(
    <>
      <AgentAvatar avatarKey="duet" duet className="size-9" />
      <AgentAvatar avatarKey="research-agent" className="size-9" />
    </>,
  )

  expect(html).toContain('data-agent-avatar="duet"')
  expect(html.match(/data-avatar-shape="squarish"/g)).toHaveLength(2)
  expect(html).toContain('/icons/duet-avatar.png')
  expect(html).toContain('data-agent-avatar="dicebear"')
  expect(html).toContain('data:image/svg+xml')
})

/* The generated face is the whole face. It used to be a translucent glass
   pattern with the agent's initials burned over the middle of it, because the
   pattern alone said nothing about which agent you were looking at. A drawn
   robot does, so the letters came off — and this asserts the absence, since a
   monogram creeping back is exactly the kind of change that looks like an
   improvement in a diff. */
test('an agent face carries no initials over it', () => {
  const html = renderToStaticMarkup(<AgentAvatar avatarKey="research-agent" className="size-9" />)

  expect(html).not.toContain('monogram')
  expect(html).not.toContain('>RA<')
})

/* An agent that has uploaded an image wears it instead of the drawn robot. Two
   ways in, because two kinds of caller exist: a surface holding the agent
   record resolves the URL through the drive (`profile` + `workspaceSlug`), and
   one fed by the knowledge map's projection already holds a resolved URL
   (`src`), since the map draws into SVG where an `<image href>` is the only way
   in. Both must land on the same answer — the rail took the second kind of
   input and drew the robot anyway for months. */
test('an uploaded image is drawn instead of the generated face, from either kind of caller', () => {
  const resolved = renderToStaticMarkup(
    <AgentAvatar avatarKey="analyst" src="https://drive.example/agents/analyst/icon.png" />,
  )
  const fromProfile = renderToStaticMarkup(
    <AgentAvatar
      avatarKey="analyst"
      profile={{ anchorPath: 'agents/analyst', icon: 'assets/icon.png', updatedAt: 1 }}
      workspaceSlug="acme"
    />,
  )

  expect(resolved).toContain('data-agent-avatar="custom"')
  expect(resolved).toContain('https://drive.example/agents/analyst/icon.png')
  expect(fromProfile).toContain('data-agent-avatar="custom"')
  /* The version the drive busts its cache with. Replacing an image and getting
     the old one back is the failure this exists to prevent. */
  expect(fromProfile).toContain('src="/api/duet/ws/acme/files/agents/analyst/assets/icon.png?v=1"')
})

/* Duet is authored art, not an uploaded file and not a generated face. Its
   record carries no `icon` on the wire at all (`GatewayAgentConfigSchema`'s
   root arm is slug and name), so `duet` deciding before either image branch is
   the correct order rather than an oversight — pinned so it stays deliberate. */
test('Duet keeps its own art even when an icon is handed to it', () => {
  const html = renderToStaticMarkup(
    <AgentAvatar avatarKey="root" duet src="https://drive.example/whatever.png" />,
  )

  expect(html).toContain('data-agent-avatar="duet"')
  expect(html).toContain('/icons/duet-avatar.png')
  expect(html).not.toContain('drive.example')
})

/* An agent with no image at all still gets a face, and it is *that agent's*
   face — the seed is the slug, so the picture is stable across every surface
   and across a rename. */
test('an agent with no uploaded image falls back to its own seeded face', () => {
  const html = renderToStaticMarkup(<AgentAvatar avatarKey="analyst" />)

  expect(html).toContain('data-agent-avatar="dicebear"')
  expect(html).toContain(createAgentAvatarDataUri('analyst').replaceAll('&', '&amp;'))
})
