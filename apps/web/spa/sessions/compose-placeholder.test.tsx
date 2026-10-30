import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'

import en from '../../messages/en/app.json'
import es from '../../messages/es-419/app.json'
import {
  composePlaceholderFor,
  PinnedComposePlaceholderRoll,
  useComposePlaceholder,
} from './compose-placeholder'

const EN_POOL = en.duetApp.sessionProduct.taskPlaceholders
const ES_POOL = es.duetApp.sessionProduct.taskPlaceholders

/** A pool entry as the composer shows it: addressed to the agent it talks to. */
const addressed = (prompt: string, name = 'Duet') => prompt.replaceAll('{name}', name)

/** The placeholder as a mounted composer would receive it, nothing else. */
function placeholderOf(
  locale: string,
  messages: unknown,
  pinnedRoll: number | null = null,
  agentName = 'Duet',
): string {
  function Probe() {
    return <>{useComposePlaceholder(agentName)}</>
  }
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages as Record<string, never>}>
      <PinnedComposePlaceholderRoll.Provider value={pinnedRoll}>
        <Probe />
      </PinnedComposePlaceholderRoll.Provider>
    </NextIntlClientProvider>,
  )
}

test('every prompt in the pool is reachable, and no roll falls off either end', () => {
  const rolled = EN_POOL.map((_, index) =>
    composePlaceholderFor(EN_POOL, index / EN_POOL.length, 'fallback'),
  )

  expect(rolled).toEqual([...EN_POOL])
  // `Math.random()` is exclusive of 1, but a roll that rounds up must still
  // land on a prompt rather than on `undefined`.
  const last = EN_POOL[EN_POOL.length - 1]!
  expect(composePlaceholderFor(EN_POOL, 0.999_999_999, 'fallback')).toBe(last)
  expect(composePlaceholderFor(EN_POOL, 1, 'fallback')).toBe(last)
})

test('a composer greets you in its own locale, and never with a stray key', () => {
  for (const { locale, messages, pool } of [
    { locale: 'en', messages: en, pool: EN_POOL },
    { locale: 'es-419', messages: es, pool: ES_POOL },
  ]) {
    const prompts = pool.map(prompt => addressed(prompt))
    expect(pool.length).toBeGreaterThan(1)
    expect(
      pool.map((_, index) => placeholderOf(locale, messages, (index + 0.5) / pool.length)),
    ).toEqual(prompts)
    expect(prompts).toContain(placeholderOf(locale, messages))
  }
})

test('a locale that has not translated the pool still gets a sentence', () => {
  const untranslated = {
    ...es,
    duetApp: {
      ...es.duetApp,
      sessionProduct: { ...es.duetApp.sessionProduct, taskPlaceholders: undefined },
    },
  }

  expect(placeholderOf('es-419', untranslated)).toBe(
    addressed(es.duetApp.sessionProduct.describeTask),
  )
})

test('a pinned roll holds the bar still, so a screenshot gate photographs one prompt', () => {
  expect(placeholderOf('en', en, 0)).toBe(addressed(EN_POOL[0]!))
  expect(placeholderOf('es-419', es, 0)).toBe(addressed(ES_POOL[0]!))
})

/* The greeting addresses whoever this composer talks to. A prompt that names
   an agent names this one, never a hard-coded "Duet". */
test('a prompt that names an agent names the one you are talking to', () => {
  const named = EN_POOL.findIndex(prompt => prompt.includes('{name}'))
  expect(named).toBeGreaterThanOrEqual(0)
  const roll = (named + 0.5) / EN_POOL.length
  const html = placeholderOf('en', en, roll, 'Research')
  expect(html).toContain('Research')
  expect(html).not.toContain('Duet')
  expect(html).not.toContain('{name}')
})
