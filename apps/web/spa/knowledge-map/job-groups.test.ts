import { expect, test } from 'bun:test'

import { seatedJobs } from './job-groups'
import type { Job } from './types'

function job(id: string, over: Partial<Job> = {}): Job {
  return { id, title: id, when: 'now', state: 'running', unread: false, ...over }
}

test('the jobs section seats completed sessions only after every unfinished session', () => {
  const jobs = [
    job('done-new', { state: 'done', updatedAt: 9_000 }),
    job('running', { state: 'running', updatedAt: 1_000 }),
    job('done-old', { state: 'done', updatedAt: 8_000 }),
    job('asking', { state: 'asking', updatedAt: 500 }),
    job('scheduled', { state: 'scheduled', updatedAt: 2_000 }),
  ]
  expect(seatedJobs(jobs).map(entry => entry.id)).toEqual([
    'asking',
    'running',
    'scheduled',
    'done-new',
    'done-old',
  ])
})

test('the ring seats the blocked work first, whatever order the wire sent', () => {
  const wireOrder = [
    job('run-old', { state: 'running', unread: false, when: '1' }),
    job('run-new', { state: 'running', unread: false, when: '2' }),
    job('ask-old', { state: 'asking', unread: false, when: '3' }),
    job('ask-new', { state: 'asking', unread: false, when: '4' }),
    job('clock', { state: 'scheduled', unread: false, when: '5' }),
  ]
  expect(seatedJobs(wireOrder).map(j => j.id)).toEqual([
    'ask-old',
    'ask-new',
    'run-old',
    'run-new',
    'clock',
  ])
})

test('ordering is stable inside a bucket', () => {
  const same = [
    job('first', { state: 'running', unread: false }),
    job('second', { state: 'running', unread: false }),
    job('third', { state: 'running', unread: false }),
  ]
  expect(seatedJobs(same).map(j => j.id)).toEqual(['first', 'second', 'third'])
})
