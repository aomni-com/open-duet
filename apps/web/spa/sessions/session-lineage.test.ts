import { expect, test } from 'bun:test'

import { sessionLineageChip } from './session-lineage'

test('the lineage chip uses a cached parent title and links to the parent in Work', () => {
  expect(
    sessionLineageChip({
      workspaceSlug: 'acme',
      parentId: 'session_parent_12345678',
      parent: { title: 'Ops — main' },
      ownerSlug: 'ops',
    }),
  ).toEqual({
    label: 'Ops — main',
    href: '/w/acme/agents/ops/sessions/session_parent_12345678',
    deleted: false,
  })
})

test('the lineage chip stays unlinked until the parent owner is resolved', () => {
  expect(
    sessionLineageChip({
      workspaceSlug: 'acme',
      parentId: 'session_parent_12345678',
    }),
  ).toEqual({
    label: 'session_pare…',
    deleted: false,
  })
})

test('a parent no agent owns links through the root scope', () => {
  expect(
    sessionLineageChip({
      workspaceSlug: 'acme',
      parentId: 'session_parent_12345678',
      parent: { title: 'Drive chores' },
      ownerSlug: 'root',
    }).href,
  ).toBe('/w/acme/agents/root/sessions/session_parent_12345678')
})

test('the lineage chip keeps a deleted parent visible without a broken link', () => {
  expect(
    sessionLineageChip({
      workspaceSlug: 'acme',
      parentId: 'session_parent_12345678',
      ownerSlug: 'ops',
      deleted: true,
    }),
  ).toEqual({
    label: 'session_pare…',
    deleted: true,
  })
})

/* The commonest lineage there is: an agent spawned this session from the
   conversation you have with it. That parent has a panel of its own and is
   withheld from the jobs dialog, so the chip names the panel — the link lands
   where it means to rather than being rewritten the moment it arrives. */
test('a parent that is its owner’s own chat links to that conversation in Work', () => {
  expect(
    sessionLineageChip({
      workspaceSlug: 'acme',
      parentId: 'session_chat_12345678',
      parent: { title: 'Ops' },
      ownerSlug: 'ops',
      chatId: 'session_chat_12345678',
    }).href,
  ).toBe('/w/acme/home?agent=ops')
})

/* One variable at a time: an owner having a chat does not move the address of
   its other work. */
test('an ordinary parent keeps its session address even when its owner has a chat', () => {
  expect(
    sessionLineageChip({
      workspaceSlug: 'acme',
      parentId: 'session_parent_12345678',
      parent: { title: 'Reconcile Q3' },
      ownerSlug: 'ops',
      chatId: 'session_chat_12345678',
    }).href,
  ).toBe('/w/acme/agents/ops/sessions/session_parent_12345678')
})
