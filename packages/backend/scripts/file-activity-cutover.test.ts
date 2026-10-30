import { expect, test } from 'bun:test'

import {
  FILE_ACTIVITY_CUTOVER_TABLES,
  FILE_ACTIVITY_CUTOVER_DEPLOYMENTS,
  assertStagingCutoverTarget,
  resetFileActivityTables,
  type FileActivityCutoverBackend,
} from './file-activity-cutover'

test('cutover target requires the exact checked-in environment deployment', () => {
  expect(() =>
    assertStagingCutoverTarget({
      environment: 'staging',
      deployment: FILE_ACTIVITY_CUTOVER_DEPLOYMENTS.staging,
      confirmedDeployment: 'different-deployment',
    }),
  ).toThrow('confirmation does not match')
  expect(() =>
    assertStagingCutoverTarget({
      environment: 'production',
      deployment: FILE_ACTIVITY_CUTOVER_DEPLOYMENTS.staging,
      confirmedDeployment: FILE_ACTIVITY_CUTOVER_DEPLOYMENTS.staging,
    }),
  ).toThrow('expected production deployment')
  expect(() =>
    assertStagingCutoverTarget({
      environment: 'staging',
      deployment: 'production-deployment',
      confirmedDeployment: 'production-deployment',
    }),
  ).toThrow('expected staging deployment')

  expect(
    assertStagingCutoverTarget({
      environment: 'staging',
      deployment: FILE_ACTIVITY_CUTOVER_DEPLOYMENTS.staging,
      confirmedDeployment: FILE_ACTIVITY_CUTOVER_DEPLOYMENTS.staging,
    }),
  ).toBe(FILE_ACTIVITY_CUTOVER_DEPLOYMENTS.staging)

  expect(
    assertStagingCutoverTarget({
      environment: 'production',
      deployment: FILE_ACTIVITY_CUTOVER_DEPLOYMENTS.production,
      confirmedDeployment: FILE_ACTIVITY_CUTOVER_DEPLOYMENTS.production,
    }),
  ).toBe(FILE_ACTIVITY_CUTOVER_DEPLOYMENTS.production)
})

test('reset drains every declared activity table and reports exact totals', async () => {
  const remaining = new Map(FILE_ACTIVITY_CUTOVER_TABLES.map((table, index) => [table, index + 1]))
  const backend: FileActivityCutoverBackend = {
    preCutoverCount: async table => remaining.get(table)!,
    replaceWithEmpty: async table => {
      remaining.set(table, 0)
    },
    isEmpty: async table => remaining.get(table)! === 0,
  }

  const result = await resetFileActivityTables(backend)

  expect(result.map(row => row.table)).toEqual([...FILE_ACTIVITY_CUTOVER_TABLES])
  expect(result.map(row => row.deleted)).toEqual(
    FILE_ACTIVITY_CUTOVER_TABLES.map((_, index) => index + 1),
  )
  expect(result.every(row => row.emptyAfter)).toBe(true)
})

test('reset refuses a table that remains populated after its drain says complete', async () => {
  const backend: FileActivityCutoverBackend = {
    preCutoverCount: async () => 1,
    replaceWithEmpty: async () => undefined,
    isEmpty: async () => false,
  }

  await expect(resetFileActivityTables(backend)).rejects.toThrow(
    'file activity reset stopped at fileEvents after 0 table(s): fileEvents still contains rows',
  )
})
