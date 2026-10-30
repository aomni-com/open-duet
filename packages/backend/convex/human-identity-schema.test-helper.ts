import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

import schema from './schema'

// Historical input exists only for migration replay; live storage stays strict.
export const beforeHumanIdentityCutoverSchema = defineSchema({
  ...schema.tables,
  apiKeys: defineTable(
    v.union(
      v.object({
        ...schema.tables.apiKeys.validator.members[0].fields,
        scopes: v.optional(v.array(v.string())),
        workspaceIds: v.optional(v.array(v.id('workspaces'))),
        workspaceId: v.optional(v.id('workspaces')),
      }),
      schema.tables.apiKeys.validator.members[1],
    ),
  ),
  deviceCodes: defineTable({
    ...schema.tables.deviceCodes.validator.fields,
    scopes: v.optional(v.array(v.string())),
    capabilities: v.optional(v.array(v.string())),
    workspaceIds: v.optional(v.array(v.id('workspaces'))),
    deviceName: v.optional(v.string()),
  }),
})
