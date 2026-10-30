#!/usr/bin/env bun

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const remoteArgument = process.argv.slice(2).find(argument => argument.startsWith('--remote='))
const unknownArguments = process.argv.slice(2).filter(argument => !argument.startsWith('--remote='))
if (unknownArguments.length > 0) throw new Error(`unknown argument: ${unknownArguments[0]}`)

const repository = await git(process.cwd(), 'rev-parse', '--show-toplevel')
const remote =
  remoteArgument === undefined
    ? await git(repository, 'remote', 'get-url', 'origin')
    : remoteArgument.slice('--remote='.length)
if (remote === '') throw new Error('--remote requires a value')

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'duet-promote-staging-'))
const worktree = path.join(temporaryDirectory, 'worktree')
let worktreeAdded = false

try {
  const advertised = await git(repository, 'ls-remote', '--heads', remote, 'main', 'staging')
  const tips = new Map(
    advertised.split('\n').map(line => {
      const [commit, ref] = line.split(/\s+/)
      return [ref, commit] as const
    }),
  )
  const mainTip = requiredTip(tips, 'refs/heads/main')
  const stagingTip = requiredTip(tips, 'refs/heads/staging')
  await git(repository, 'fetch', '--quiet', '--no-tags', remote, 'main', 'staging')

  if (await gitSucceeds(repository, 'merge-base', '--is-ancestor', stagingTip, mainTip)) {
    console.log(`origin/main already contains origin/staging (${stagingTip})`)
  } else {
    await git(repository, 'worktree', 'add', '--quiet', '--detach', worktree, mainTip)
    worktreeAdded = true
    await git(worktree, 'merge', '--no-ff', stagingTip, '-m', 'Merge origin/staging into main')
    const mergeTip = await git(worktree, 'rev-parse', 'HEAD')

    // This is an ordinary fast-forward push. If main moved after the fetch, Git
    // refuses it rather than replacing concurrent work.
    await git(worktree, 'push', remote, 'HEAD:refs/heads/main')
    console.log(`promoted origin/staging ${stagingTip} to origin/main as ${mergeTip}`)
  }
} finally {
  if (worktreeAdded) await git(repository, 'worktree', 'remove', '--force', worktree)
  await rm(temporaryDirectory, { recursive: true, force: true })
}

function requiredTip(tips: Map<string | undefined, string | undefined>, ref: string): string {
  const tip = tips.get(ref)
  if (tip === undefined) throw new Error(`remote does not advertise ${ref}`)
  return tip
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runGit(cwd, args)
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

async function gitSucceeds(cwd: string, ...args: string[]): Promise<boolean> {
  return (await runGit(cwd, args)).exitCode === 0
}

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}
