import { expect, test } from 'bun:test'

import {
  AttachAppDomainRequestSchema,
  DomainObservationSchema,
  normalizeAppDomainHostname,
} from './index'

test('normalizes pasted URLs to one DNS hostname identity', () => {
  expect(normalizeAppDomainHostname('  HTTPS://Tools.Example.COM///  ')).toBe('tools.example.com')
  expect(normalizeAppDomainHostname('tools.example.com')).toBe('tools.example.com')
})

test('refuses URLs with a path and hostnames that cannot address a customer app', () => {
  for (const input of [
    'https://example.com/app',
    'example.com?app=x',
    'example.com:443',
    '*.example.com',
    '127.0.0.1',
    'localhost',
    'duet.so',
    'app.duet.so',
    'duet.chat',
    `${'a'.repeat(64)}.example.com`,
  ]) {
    expect(() => normalizeAppDomainHostname(input)).toThrow()
  }
  expect(normalizeAppDomainHostname('xn--bcher-kva.example')).toBe('xn--bcher-kva.example')
})

test('rejects numeric hostname spellings that browsers interpret as IP addresses', () => {
  for (const input of ['127.1', '0x7f.0.0.1', '0177.1']) {
    expect(new URL(`https://${input}`).hostname).toBe('127.0.0.1')
    expect(() => normalizeAppDomainHostname(input)).toThrow()
  }
})

test('rejects Unicode input rather than silently converting it to another hostname', () => {
  expect(() => normalizeAppDomainHostname('K.example')).toThrow()
})

test('rejects unknown attachment options so the caller cannot mistake them for supported behavior', () => {
  expect(() =>
    AttachAppDomainRequestSchema.parse({ hostname: 'example.com', publish: true }),
  ).toThrow()
})

test('bounds complete provider diagnostics before they can enter storage', () => {
  const record = { type: 'TXT', domain: 'example.com', value: 'é'.repeat(2_048) }
  const observation = {
    hostname: 'example.com',
    apexName: 'example.com',
    ownershipVerified: false,
    misconfigured: true,
    records: Array.from({ length: 32 }, () => ({ ...record, reason: 'é'.repeat(512) })),
    conflicts: [{ name: 'example.com', type: 'A', value: '76.76.21.21' }],
    target: { projectId: 'edge-project', gitBranch: 'staging' },
  }
  expect(DomainObservationSchema.parse(observation)).toEqual(observation)
  for (const records of [
    [...observation.records, record],
    [{ ...record, value: `${record.value}é` }],
    [{ ...record, reason: 'é'.repeat(513) }],
  ]) {
    expect(() => DomainObservationSchema.parse({ ...observation, records })).toThrow()
  }
  expect(() =>
    DomainObservationSchema.parse({
      ...observation,
      conflicts: Array.from({ length: 33 }, () => observation.conflicts[0]),
    }),
  ).toThrow()
})
