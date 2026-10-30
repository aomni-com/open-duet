import { expect, test } from 'bun:test'

import { WEB_CACHE_SCHEMA_VERSION, WebDeploymentSchema } from '@repo/contract'

import { GET } from './route'

test('the version probe answers uncached with its deployed release identity', async () => {
  const revision = 'a'.repeat(40)
  const routeUrl = new URL('./route.ts', import.meta.url).href
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
      const { GET } = await import(${JSON.stringify(routeUrl)});
      const response = GET();
      console.log(JSON.stringify({
        status: response.status,
        cacheControl: response.headers.get('cache-control'),
        body: await response.json(),
      }));
    `,
    ],
    {
      env: {
        ...process.env,
        VERCEL_GIT_COMMIT_SHA: revision,
        VERCEL_DEPLOYMENT_ID: 'deployment-fixture',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, stderr).toBe(0)
  const response = JSON.parse(stdout)
  expect(response.status).toBe(200)
  expect(response.cacheControl).toContain('no-store')
  expect(response.body.version).toBe('deployment-fixture')
  expect(WebDeploymentSchema.parse(response.body)).toEqual({
    revision,
    cacheSchema: WEB_CACHE_SCHEMA_VERSION,
  })
})

test('the probe reports one stable identity for the life of the process', async () => {
  const [first, second] = await Promise.all([
    (await GET()).json() as Promise<{ version: string }>,
    (await GET()).json() as Promise<{ version: string }>,
  ])

  expect(first.version).toBe(second.version)
})
