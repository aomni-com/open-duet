import { afterAll, beforeAll, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { chromium, type Browser } from '@playwright/test'

const dockerTest = process.env.RUN_DOCKER_TESTS === '1' ? test : test.skip
const image = process.env.DESKTOP_IMAGE_REF ?? 'duet-vm-image:local'
const containerName = `duet-desktop-kg2-${process.pid}-${Date.now()}`
const outputDir = await mkdtemp(join(tmpdir(), 'duet-desktop-kg2-'))
const harnessBundle = join(outputDir, 'render-harness.js')
let origin = ''
let browser: Browser | undefined

beforeAll(async () => {
  if (process.env.RUN_DOCKER_TESTS !== '1') return
  await run('bun', [
    'build',
    'src/desktop/render-harness.ts',
    '--target=bun',
    `--outfile=${harnessBundle}`,
  ])
  await run('docker', [
    'run',
    '--detach',
    '--name',
    containerName,
    '--platform',
    'linux/amd64',
    '--publish',
    '127.0.0.1::3000',
    '--volume',
    `${harnessBundle}:/tmp/render-harness.js:ro`,
    '--entrypoint',
    'bash',
    image,
    '-lc',
    [
      'set -euo pipefail',
      'runuser -u exedev -- /opt/duet/bin/ensure-kasm-credentials.sh',
      'runuser -u exedev -- env HOME=/home/exedev /usr/bin/kasmvncserver :1',
      'exec runuser -u exedev -- env PORT=3000 bun /tmp/render-harness.js',
    ].join('; '),
  ])
  const mapping = (await run('docker', ['port', containerName, '3000/tcp'])).trim()
  const port = mapping.match(/:(\d+)$/)?.[1]
  if (port === undefined) throw new Error(`could not parse Docker port mapping: ${mapping}`)
  origin = `http://127.0.0.1:${port}`
  await waitForHttp(`${origin}/kg2-entry`)
  const grant = await fetch(`${origin}/kg2-grant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ embedOrigin: origin }),
  })
  if (!grant.ok) throw new Error(`desktop render grant failed: ${grant.status}`)
  browser = await chromium.launch({ headless: true })
})

afterAll(async () => {
  await browser?.close()
  if (process.env.RUN_DOCKER_TESTS === '1') {
    await run('docker', ['rm', '--force', containerName]).catch(() => undefined)
  }
  await rm(outputDir, { recursive: true, force: true })
})

dockerTest(
  'a browser renders and drives the desktop through the gateway bridge',
  async () => {
    if (browser === undefined) throw new Error('browser did not start')
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(`${origin}/kg2-host`)
    const frame = await waitForDesktopFrame(page)

    expect(await page.evaluate(() => crossOriginIsolated)).toBe(false)
    expect(await frame.evaluate(() => crossOriginIsolated)).toBe(false)
    await expectCanvasPixels(frame)
    await waitForStableCanvas(frame)
    await frame
      .locator('#noVNC_container canvas[width="1440"][height="900"]')
      .first()
      .screenshot({
        path: resolve(
          import.meta.dir,
          '../../../../specs/done/vm-desktop/assets/kasmvnc-slice03-gateway.png',
        ),
      })

    await startInputWitness()
    await page.mouse.click(700, 400)
    await page.keyboard.type('kg2')
    await page.mouse.click(710, 410)
    await waitForInputWitness('KeyPress')
    await waitForInputWitness('ButtonPress')
    await page.close()
  },
  60_000,
)

dockerTest(
  'the same viewer capability is refused from a different parent origin',
  async () => {
    if (browser === undefined) throw new Error('browser did not start')
    const refusedOrigin = origin.replace('127.0.0.1', 'localhost')
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const consoleMessages: string[] = []
    page.on('console', message => consoleMessages.push(message.text()))

    await page.goto(`${refusedOrigin}/kg2-host`)
    await Bun.sleep(500)

    expect(page.frames().some(frame => frame.url().includes('/v1/desktop/'))).toBe(false)
    expect(consoleMessages.join('\n')).toContain('frame-ancestors')
    await page.close()
  },
  60_000,
)

async function waitForDesktopFrame(
  page: import('@playwright/test').Page,
): Promise<import('@playwright/test').Frame> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const frame = page.frames().find(candidate => candidate.url().includes('/v1/desktop/'))
    if (frame !== undefined) return frame
    await Bun.sleep(100)
  }
  throw new Error('desktop iframe did not navigate')
}

async function waitForStableCanvas(frame: import('@playwright/test').Frame): Promise<void> {
  let previousHash: number | undefined
  let stableSamples = 0
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const hash = await frame.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        '#noVNC_container canvas[width="1440"][height="900"]',
      )
      const context = canvas?.getContext('2d')
      if (canvas === null || canvas === undefined || context === null || context === undefined) {
        return undefined
      }
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let value = 2_166_136_261
      for (const channel of pixels) value = Math.imul(value ^ channel, 16_777_619)
      return value >>> 0
    })
    stableSamples = hash !== undefined && hash === previousHash ? stableSamples + 1 : 0
    if (stableSamples >= 2) return
    previousHash = hash
    await Bun.sleep(250)
  }
  throw new Error('desktop canvas did not settle before capture')
}

async function expectCanvasPixels(frame: import('@playwright/test').Frame): Promise<void> {
  try {
    await frame.waitForFunction(
      () => {
        for (const canvas of document.querySelectorAll<HTMLCanvasElement>(
          '#noVNC_container canvas',
        )) {
          if (canvas.width !== 1440 || canvas.height !== 900) continue
          const context = canvas.getContext('2d')
          if (context === null) continue
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
          const first = `${pixels[0]},${pixels[1]},${pixels[2]}`
          for (let offset = 0; offset < pixels.length; offset += 4 * 4096) {
            if (`${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}` !== first)
              return true
          }
        }
        return false
      },
      undefined,
      { timeout: 30_000 },
    )
  } catch (error) {
    console.log(`[browser:status] ${await frame.locator('#noVNC_status').textContent()}`)
    console.log(
      `[browser:canvases] ${JSON.stringify(
        await frame.locator('canvas').evaluateAll(canvases =>
          canvases.map(canvas => ({
            id: canvas.id,
            width: (canvas as HTMLCanvasElement).width,
            height: (canvas as HTMLCanvasElement).height,
          })),
        ),
      )}`,
    )
    console.log(await run('docker', ['logs', containerName]).catch(logError => String(logError)))
    throw error
  }
}

async function startInputWitness(): Promise<void> {
  await run('docker', [
    'exec',
    '--detach',
    containerName,
    'runuser',
    '-u',
    'exedev',
    '--',
    'bash',
    '-lc',
    'DISPLAY=:1 xev -event keyboard -event button -geometry 400x200+500+300 > /tmp/kg2-xev.log 2>&1',
  ])
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await runAllowFailure('docker', ['exec', containerName, 'pgrep', '-x', 'xev'])) === 0)
      return
    await Bun.sleep(100)
  }
  throw new Error('xev input witness did not start')
}

async function waitForInputWitness(pattern: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const log = await run('docker', ['exec', containerName, 'cat', '/tmp/kg2-xev.log']).catch(
      () => '',
    )
    if (log.includes(pattern)) return
    await Bun.sleep(100)
  }
  throw new Error(`remote input witness did not observe ${pattern}`)
}

async function waitForHttp(url: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (
      await fetch(url)
        .then(response => response.ok)
        .catch(() => false)
    )
      return
    await Bun.sleep(100)
  }
  const logs = await run('docker', ['logs', containerName]).catch(error => String(error))
  throw new Error(`desktop render harness did not start\n${logs}`)
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: resolve(import.meta.dir, '../..') })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += String(chunk)))
    child.stderr.on('data', chunk => (stderr += String(chunk)))
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) resolveRun(stdout)
      else reject(new Error(`${command} ${args.join(' ')} failed (${code})\n${stderr}`))
    })
  })
}

function runAllowFailure(command: string, args: string[]): Promise<number> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', code => resolveRun(code ?? 1))
  })
}
