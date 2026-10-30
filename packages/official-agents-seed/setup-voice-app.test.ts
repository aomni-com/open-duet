import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSetupVoiceApp } from './content/agents/writer/apps/setup-voice/server'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  const results = await Promise.allSettled(cleanup.splice(0).map(stop => stop()))
  const errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
  if (errors.length > 0) throw new AggregateError(errors, 'Voice fixture cleanup failed')
})

/** Comfortably past the 150-word floor the app requires. */
const SAMPLE = 'The invoices were the boring part and nobody read them. We did. '.repeat(20)

const VOICE = [
  '## Register',
  'Plain and declarative, written for operators.',
  '',
  '## Preserve',
  '- The very short sentence used as a full stop.',
  '',
  '## Tics to leave alone',
  '- Paragraphs that open with "We".',
].join('\n')

function fakePlatform() {
  const state = {
    voice: VOICE as string | null,
    modelStatus: 200,
    writeStatus: 200,
    sampleWriteStatus: 200,
    writes: [] as Array<{ path: string; body: string }>,
    onboardedCalls: [] as Array<{ onboarded: boolean }>,
    modelPrompts: [] as string[],
    modelCalls: [] as Array<{ model: string; temperature?: number }>,
  }
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const headers = new Headers(init?.headers)
    if (url.pathname === '/v1/whoami') return Response.json({ workspaces: [{ slug: 'acme-hq' }] })
    if (url.pathname === '/v1/chat/completions') {
      const body = JSON.parse(String(init?.body)) as {
        model: string
        temperature?: number
        messages: Array<{ content: string }>
      }
      state.modelPrompts.push(body.messages[0]!.content)
      state.modelCalls.push({ model: body.model, temperature: body.temperature })
      if (state.modelStatus !== 200 || state.voice === null) {
        return Response.json({ error: 'no' }, { status: 503 })
      }
      expect(headers.get('x-duet-tier')).toBe('services')
      return Response.json({ choices: [{ message: { content: state.voice } }] })
    }
    if (url.pathname.startsWith('/v1/ws/acme-hq/files/')) {
      if (url.pathname.includes('/voice/samples/') && state.sampleWriteStatus !== 200)
        return Response.json({ error: 'sample write failed' }, { status: state.sampleWriteStatus })
      if (state.writeStatus !== 200)
        return Response.json({ error: 'no' }, { status: state.writeStatus })
      state.writes.push({
        path: decodeURIComponent(url.pathname.replace('/v1/ws/acme-hq/files/', '')),
        body: await new Response(init?.body ?? null).text(),
      })
      return Response.json({ ok: true })
    }
    if (url.pathname === '/v1/ws/acme-hq/app/onboarded') {
      state.onboardedCalls.push(JSON.parse(String(init?.body)) as { onboarded: boolean })
      return Response.json({ agent: { id: 'agent_1', slug: 'writer' } })
    }
    throw new Error(`unexpected path ${url.pathname}`)
  }
  return { state, fetchImpl }
}

/**
 * Deliberately NOT `agents/writer`: the user named this copy on install, and the
 * manifest's canonical path is right only for the official hub. A regression to
 * a hardcoded folder fails every path assertion below.
 */
const AGENT_DIR = 'agents/my-writer'

const env = {
  DUET_API_URL: 'https://duet.test',
  DUET_APP_API_KEY: 'app-key',
  DUET_GATEWAY_BASE_URL: 'https://gateway.test',
  DUET_AGENT_DIR: AGENT_DIR,
}

async function startApp(platform = fakePlatform()) {
  const directory = await mkdtemp(join(tmpdir(), 'duet-setup-voice-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const app = createSetupVoiceApp({ directory, port: 0, fetchImpl: platform.fetchImpl, env })
  cleanup.push(async () => {
    await app.stop()
  })
  return { ...app, directory, platform }
}

async function addSamples(url: URL, ...files: Array<{ name: string; text: string }>) {
  const form = new FormData()
  for (const file of files) {
    form.append('sample', new File([file.text], file.name, { type: 'text/markdown' }))
  }
  return await fetch(new URL('/api/samples', url), { method: 'POST', body: form })
}

test('reads attached files and shows what it read back', async () => {
  const app = await startApp()

  const response = await addSamples(app.url, { name: 'essay.md', text: SAMPLE })
  expect(response.status).toBe(200)
  const status = (await response.json()) as {
    profile: { samples: Array<{ name: string; words: number; excerpt: string }>; licence: string }
  }
  expect(status.profile.samples).toHaveLength(1)
  expect(status.profile.samples[0]!.name).toBe('essay.md')
  expect(status.profile.samples[0]!.words).toBe(240)
  // The excerpt is what makes a mis-attached file obvious before anything runs.
  expect(status.profile.samples[0]!.excerpt).toContain('The invoices were the boring part')
  expect(status.profile.licence).toBe('balanced')
})

test('too little writing is refused, and nothing is spent on it', async () => {
  const app = await startApp()

  const response = await addSamples(app.url, { name: 'note.md', text: 'One short line.' })
  expect(response.status).toBe(400)
  expect(((await response.json()) as { error: string }).error).toMatch(/add a bit more/i)
  expect(app.platform.state.modelPrompts).toEqual([])
})

test('pasted writing counts the same as an attached file', async () => {
  const app = await startApp()
  const form = new FormData()
  form.append('sample', SAMPLE)

  const response = await fetch(new URL('/api/samples', app.url), { method: 'POST', body: form })
  expect(response.status).toBe(200)
  const status = (await response.json()) as { profile: { samples: Array<{ name: string }> } }
  expect(status.profile.samples[0]!.name).toBe('pasted.md')
})

test('the licence is the authors decision and survives a re-read', async () => {
  const app = await startApp()
  await addSamples(app.url, { name: 'essay.md', text: SAMPLE })

  const set = await fetch(new URL('/api/licence', app.url), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ licence: 'firm' }),
  })
  expect(((await set.json()) as { profile: { licence: string } }).profile.licence).toBe('firm')

  // Adding another sample must not quietly reset a choice the author made.
  const again = await addSamples(app.url, { name: 'second.md', text: SAMPLE })
  expect(((await again.json()) as { profile: { licence: string } }).profile.licence).toBe('firm')
})

test('confirming writes the profile beside the samples it was read from', async () => {
  const app = await startApp()
  await addSamples(app.url, { name: 'essay.md', text: SAMPLE })

  const confirmed = await fetch(new URL('/api/confirm', app.url), { method: 'POST' })
  expect(confirmed.status).toBe(200)

  expect(app.platform.state.writes.map(write => write.path)).toEqual([
    `${AGENT_DIR}/voice/samples/essay.md`,
    `${AGENT_DIR}/voice/author-voice.md`,
  ])
  const profile = app.platform.state.writes[1]!.body
  expect(profile).toContain('# Author voice')
  expect(profile).toContain('**balanced**')
  expect(profile).toContain('## Preserve')
  // The samples are the evidence behind every "I left this alone".
  expect(app.platform.state.writes[0]!.body).toBe(SAMPLE.trim())
  expect(app.platform.state.onboardedCalls).toEqual([{ onboarded: true }])
})

test('the licence reaches the profile as a rule the agent can act on', async () => {
  const app = await startApp()
  await addSamples(app.url, { name: 'essay.md', text: SAMPLE })
  await fetch(new URL('/api/licence', app.url), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ licence: 'light' }),
  })

  await fetch(new URL('/api/confirm', app.url), { method: 'POST' })
  const profile = app.platform.state.writes.at(-1)!.body
  expect(profile).toContain('**light** — Copyedit only. Do not restructure')
})

test('the samples themselves are what the model is asked to read', async () => {
  const app = await startApp()
  await addSamples(app.url, { name: 'essay.md', text: SAMPLE })
  await fetch(new URL('/api/confirm', app.url), { method: 'POST' })

  expect(app.platform.state.modelPrompts).toHaveLength(1)
  const prompt = app.platform.state.modelPrompts[0]!
  expect(prompt).toContain('essay.md')
  expect(prompt).toContain('The invoices were the boring part')
  // Reading the author, never grading them.
  expect(prompt).toContain('Do not judge the writing')
})

test('a profile is still written when the model is unreachable', async () => {
  const platform = fakePlatform()
  platform.state.voice = null
  const app = await startApp(platform)
  await addSamples(app.url, { name: 'essay.md', text: SAMPLE })

  expect((await fetch(new URL('/api/confirm', app.url), { method: 'POST' })).status).toBe(200)
  const profile = platform.state.writes.at(-1)!.body
  expect(profile).toContain('**balanced**')
  expect(profile).toContain('_Not yet read — ask the author before the first edit._')
  expect(platform.state.onboardedCalls).toEqual([{ onboarded: true }])
})

test('the agent stays locked when the profile cannot be saved', async () => {
  const platform = fakePlatform()
  platform.state.writeStatus = 500
  const app = await startApp(platform)
  await addSamples(app.url, { name: 'essay.md', text: SAMPLE })

  expect((await fetch(new URL('/api/confirm', app.url), { method: 'POST' })).status).toBe(502)
  expect(platform.state.onboardedCalls).toEqual([])
})

test('the agent stays locked when a source sample cannot be saved', async () => {
  const platform = fakePlatform()
  platform.state.sampleWriteStatus = 500
  const app = await startApp(platform)
  await addSamples(app.url, { name: 'essay.md', text: SAMPLE })

  const response = await fetch(new URL('/api/confirm', app.url), { method: 'POST' })
  expect(response.status).toBe(502)
  expect(((await response.json()) as { error: string }).error).toMatch(/sample.*saved/i)
  expect(platform.state.writes).toEqual([])
  expect(platform.state.onboardedCalls).toEqual([])
  const status = (await (await fetch(new URL('/api/status', app.url))).json()) as {
    complete: boolean
  }
  expect(status.complete).toBe(false)
})

test('confirming before any writing is refused', async () => {
  const app = await startApp()
  const response = await fetch(new URL('/api/confirm', app.url), { method: 'POST' })
  expect(response.status).toBe(409)
  expect(app.platform.state.onboardedCalls).toEqual([])
})

test('an upload name cannot escape the samples folder', async () => {
  for (const [name, filename] of [
    ['../../etc/passwd', 'etc-passwd'],
    ['my essay (final).md', 'my-essay-final-.md'],
    ['', 'sample.md'],
    ['...', 'sample.md'],
  ]) {
    const app = await startApp()
    expect((await addSamples(app.url, { name: name!, text: SAMPLE })).status).toBe(200)
    expect((await fetch(new URL('/api/confirm', app.url), { method: 'POST' })).status).toBe(200)
    expect(app.platform.state.writes[0]).toEqual({
      path: `${AGENT_DIR}/voice/samples/${filename}`,
      body: SAMPLE.trim(),
    })
  }
})

test('only the three licences are accepted', async () => {
  const app = await startApp()
  await addSamples(app.url, { name: 'essay.md', text: SAMPLE })
  for (const licence of ['light', 'balanced', 'firm', 'anything', 7]) {
    const response = await fetch(new URL('/api/licence', app.url), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ licence }),
    })
    if (licence === 'anything' || licence === 7) {
      expect(response.status).toBe(400)
      expect(((await response.json()) as { error: string }).error).toBe(
        'Pick how far the edit may go.',
      )
      const status = (await (await fetch(new URL('/api/status', app.url))).json()) as {
        profile: { licence: string }
      }
      expect(status.profile.licence).toBe('firm')
    } else {
      expect(response.status).toBe(200)
      expect(((await response.json()) as { profile: { licence: string } }).profile.licence).toBe(
        String(licence),
      )
    }
  }
})

test('serves upload and paste controls with viewport metadata and event wiring', async () => {
  const app = await startApp()
  const html = await (await fetch(app.url)).text()

  expect(html).toContain('name="viewport"')
  expect(html.match(/new EventSource\('\/events'\)/g)).toHaveLength(1)
  expect(html).not.toContain('WebSocket')
  expect(html).toContain('type="file"')
  expect(html).toContain('<textarea')
})

// Sample text lives in memory until the author confirms, so an app restart in
// between leaves the stored profile pointing at writing the app no longer holds.
// Reading a voice from nothing would still produce confident-looking prose, and
// writing that as "what to preserve" is worse than asking again.
test('a restart between adding and confirming asks for the writing again', async () => {
  const app = await startApp()
  await addSamples(app.url, { name: 'essay.md', text: SAMPLE })

  app.stop()
  const restarted = createSetupVoiceApp({
    directory: app.directory,
    port: 0,
    fetchImpl: app.platform.fetchImpl,
    env,
  })
  cleanup.push(async () => restarted.stop())

  const confirmed = await fetch(new URL('/api/confirm', restarted.url), { method: 'POST' })
  expect(confirmed.status).toBe(409)
  expect(app.platform.state.modelPrompts).toEqual([])
  expect(app.platform.state.onboardedCalls).toEqual([])
})

// Same contract as its sibling: no folder from the platform, no write, no
// unlock. A guessed folder plus an unlocked card is the stranding this
// onboarding exists to prevent.
test('without a folder from the platform it writes nothing and unlocks nothing', async () => {
  const platform = fakePlatform()
  const directory = await mkdtemp(join(tmpdir(), 'duet-setup-voice-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const { DUET_AGENT_DIR: _absent, ...withoutFolder } = env
  const app = createSetupVoiceApp({
    directory,
    port: 0,
    fetchImpl: platform.fetchImpl,
    env: withoutFolder,
  })
  cleanup.push(async () => {
    await app.stop()
  })

  const status = (await (await fetch(new URL('/api/status', app.url))).json()) as {
    ready: boolean
  }
  expect(status.ready).toBe(false)

  await addSamples(app.url, { name: 'essay.md', text: SAMPLE })
  const confirmed = await fetch(new URL('/api/confirm', app.url), { method: 'POST' })
  expect(confirmed.status).toBe(503)
  expect(platform.state.writes).toEqual([])
  expect(platform.state.onboardedCalls).toEqual([])
})
