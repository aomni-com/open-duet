import { expect, test } from 'bun:test'

import { getLlmsPage } from '@/lib/llms/pages'

import { generateStaticParams, GET } from './route'

const get = (path: string[]) =>
  GET(new Request('https://lander.test'), { params: Promise.resolve({ path }) })

test('serves the markdown twin of a page as markdown', async () => {
  const response = await get(['for', 'roofers'])
  const page = await getLlmsPage('/for/roofers')

  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
  expect(await response.text()).toBe(page?.markdown ?? '')
})

test('serves the homepage twin under the index segment', async () => {
  const response = await get(['index'])
  const home = await getLlmsPage('/')

  expect(await response.text()).toBe(home?.markdown ?? '')
})

// Half the contract. The other half is that the request reaches this handler
// at all rather than falling through to the page tree, which only the real
// router decides — `verify:build-output` covers it.
test('404s a path the site does not publish rather than inventing a page', async () => {
  expect((await get(['vs', 'chatgpt'])).status).toBe(404)
  expect((await get(['blog', 'no-such-post'])).status).toBe(404)
})

test('prerenders one twin per published page', async () => {
  const params = await generateStaticParams()

  expect(params).toContainEqual({ path: ['index'] })
  expect(params).toContainEqual({ path: ['use-cases', 'by-job', 'invoicing'] })
  expect(params.some(param => param.path.includes('es'))).toBeFalse()
})
