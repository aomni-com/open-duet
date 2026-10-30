import { describe, expect, test } from 'bun:test'

import {
  activeTargetInWindow,
  credentiallessDesktopUrl,
  isLetterboxedDesktop,
  summarizeManagedBrowserInventory,
} from './staging-live-agent-browser-windows'
import {
  handoffBatchForActiveTarget,
  handoffTurnSettled,
  handoffTranscript,
} from './staging-live-browser-human-handoff'
import { publicDesktopProbeUrl, publicDesktopSessionEvidence } from './staging-live-public-desktop'

describe('VM desktop staging journey helpers', () => {
  test('builds the credential-free form of an issued desktop URL', () => {
    expect(
      credentiallessDesktopUrl(
        'https://duet-ws.example/v1/desktop/desktop-123.browser_token/?autoconnect=1&path=secret',
      ),
    ).toBe('https://duet-ws.example/v1/desktop/desktop-123/')
  })

  test('accepts a fixed 1440x900 surface only when aspect-preserving padding remains', () => {
    expect(
      isLetterboxedDesktop({
        host: { width: 1600, height: 1000 },
        rendered: { width: 1440, height: 900 },
        intrinsic: { width: 1440, height: 900 },
        offset: { x: 80, y: 50 },
      }),
    ).toBe(true)
    expect(
      isLetterboxedDesktop({
        host: { width: 1600, height: 1000 },
        rendered: { width: 1440, height: 800 },
        intrinsic: { width: 1440, height: 900 },
        offset: { x: 80, y: 100 },
      }),
    ).toBe(false)
  })

  test('rejects a surface stuck against one letterbox edge', () => {
    expect(
      isLetterboxedDesktop({
        host: { width: 1_054, height: 944 },
        rendered: { width: 1_008, height: 630 },
        intrinsic: { width: 1440, height: 900 },
        offset: { x: 0, y: 157 },
      }),
    ).toBe(false)
  })

  test('groups supplied owner windows with their batch and tab counts', () => {
    expect(
      summarizeManagedBrowserInventory({
        windows: [
          { owner: { kind: 'root' }, chromeWindowId: 10 },
          { owner: { kind: 'agent', agentId: 'agent-a' }, chromeWindowId: 20 },
          { owner: { kind: 'agent', agentId: 'agent-b' }, chromeWindowId: 30 },
        ],
        batches: [
          { batchId: 'root-1', owner: { kind: 'root' }, tabs: [{ logicalTabId: 'r1' }] },
          {
            batchId: 'agent-a-1',
            owner: { kind: 'agent', agentId: 'agent-a' },
            tabs: [{ logicalTabId: 'a1' }],
          },
          {
            batchId: 'agent-a-2',
            owner: { kind: 'agent', agentId: 'agent-a' },
            tabs: [{ logicalTabId: 'a2' }, { logicalTabId: 'a2-popup' }],
          },
          {
            batchId: 'agent-b-1',
            owner: { kind: 'agent', agentId: 'agent-b' },
            tabs: [{ logicalTabId: 'b1' }],
          },
        ],
      }),
    ).toEqual({
      root: { windowId: 10, batchCount: 1, batchTabCount: 1 },
      'agent:agent-a': { windowId: 20, batchCount: 2, batchTabCount: 3 },
      'agent:agent-b': { windowId: 30, batchCount: 1, batchTabCount: 1 },
    })
  })

  test('retains only non-capability public desktop evidence', () => {
    expect(
      publicDesktopSessionEvidence({
        entryUrl: 'https://gateway.example/v1/desktop/grant.secret/',
        expiresAt: 123,
        phase: 'ready',
        screen: { width: 1440, height: 900 },
      }),
    ).toEqual({
      expiresAt: 123,
      phase: 'ready',
      screen: { width: 1440, height: 900 },
      responseKeys: ['entryUrl', 'expiresAt', 'phase', 'screen'],
    })
  })

  test('builds the inert probe URL on the supplied app origin', () => {
    expect(publicDesktopProbeUrl('https://app.example.test/w/acme')).toBe(
      'https://app.example.test/__duet-desktop-embed-probe',
    )
  })

  test('finds the exact active target in one native Chrome window', () => {
    expect(
      activeTargetInWindow(
        {
          snapshot: {
            windows: [
              { windowId: 99, tabs: [{ active: true, targetId: 'other-window' }] },
              {
                windowId: 20,
                focused: true,
                tabs: [
                  { tabId: 1, active: false, targetId: 'old-target' },
                  { tabId: 2, active: true, targetId: 'marked-target' },
                ],
              },
            ],
          },
        },
        20,
      ),
    ).toBe('marked-target')
  })

  test('extracts the canonical link and separate Done question from an ask turn', () => {
    expect(
      handoffTranscript({
        events: [
          {
            seq: 1,
            event: {
              type: 'step',
              step: {
                type: 'text',
                text: '[Open my desktop](/w/acme/agents/root/desktop)',
              },
            },
          },
          {
            seq: 2,
            event: {
              type: 'ask',
              questions: [
                {
                  question: 'Reply when you are finished.',
                  options: [{ label: 'Done' }, { label: "I'm stuck" }],
                },
              ],
            },
          },
        ],
      }),
    ).toEqual({
      desktopUrl: '/w/acme/agents/root/desktop',
      question: 'Reply when you are finished.',
      options: ['Done', "I'm stuck"],
    })
  })

  test('attributes the presented handoff tab to its actual new batch, not inventory order', () => {
    expect(
      handoffBatchForActiveTarget(
        [
          {
            batchId: 'older-batch',
            owner: { kind: 'agent', agentId: 'agent-a' },
            tabs: [{ targetId: 'active-target' }],
          },
          {
            batchId: 'other-owner',
            owner: { kind: 'agent', agentId: 'agent-b' },
            tabs: [{ targetId: 'active-target' }],
          },
          { batchId: 'root-owner', owner: { kind: 'root' }, tabs: [{ targetId: 'active-target' }] },
          {
            batchId: 'first-new-batch',
            owner: { kind: 'agent', agentId: 'agent-a' },
            tabs: [{ targetId: 'background-target' }],
          },
          {
            batchId: 'presented-batch',
            owner: { kind: 'agent', agentId: 'agent-a' },
            tabs: [{ targetId: 'active-target' }],
          },
        ],
        new Set(['older-batch']),
        'agent-a',
        'active-target',
      )?.batchId,
    ).toBe('presented-batch')
  })

  test('stops waiting when a handoff turn completes without asking', () => {
    expect(handoffTurnSettled({ events: [{ event: { type: 'complete' } }] })).toBe(true)
  })

})
