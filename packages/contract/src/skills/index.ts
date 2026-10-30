import { z } from 'zod'

import { CollectionPageQuerySchema, collectionPageSchema } from '../pagination/index'
import { SafeRelativePathSchema } from '../relative-path/index'

export const SkillsBundleFileSchema = z.object({
  path: SafeRelativePathSchema,
  content: z.string(),
})

export const SkillsBundleSchema = z
  .object({
    version: z.literal(1),
    files: z.array(SkillsBundleFileSchema),
  })

  .superRefine((bundle, context) => {
    let previousPath: string | undefined
    for (const [index, file] of bundle.files.entries()) {
      if (previousPath !== undefined && file.path <= previousPath) {
        context.addIssue({
          code: 'custom',
          path: ['files', index, 'path'],
          message:
            file.path === previousPath
              ? `Duplicate bundle path: ${file.path}`
              : 'Bundle files must be sorted by path',
        })
      }
      previousPath = file.path
    }
  })

export type SkillsBundleFile = z.infer<typeof SkillsBundleFileSchema>
export type SkillsBundle = z.infer<typeof SkillsBundleSchema>

/**
 * Where a skill was found, as the agent CLI reports it: the user's home, the
 * working tree it was asked about, a session-temporary install, or the agent
 * binary itself. Presentation only — nothing routes on it.
 */
export const WorkspaceSkillScopeSchema = z.enum(['user', 'project', 'temporary', 'builtin'])
export type WorkspaceSkillScope = z.infer<typeof WorkspaceSkillScopeSchema>

/**
 * One installed skill as the workspace VM sees it.
 *
 * `path` is the skill's own directory, carried through to the `<Skill …/>` tag
 * a composed message emits so the agent can open the SKILL.md without a
 * discovery step. Scopes the agent may invent later degrade to "no scope"
 * rather than rejecting the row: this listing decorates a picker, and a skill
 * the user can see and run is worth more than a label.
 */
export const WorkspaceSkillSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  path: z.string().min(1),
  scope: WorkspaceSkillScopeSchema.optional().catch(undefined),
})
export type WorkspaceSkill = z.infer<typeof WorkspaceSkillSchema>

/**
 * The workspace skill listing.
 *
 * A row the schema cannot read is dropped instead of failing the listing: the
 * VM runs whatever agent version is installed there, and one unreadable entry
 * must not cost the user every other skill. The agent also reports the name
 * collisions it resolved while discovering; nothing renders them, so they are
 * stripped here rather than plumbed to a reader that does not exist.
 */
export const WorkspaceSkillsListingSchema = z.object({
  skills: z.array(z.unknown()).transform(rows =>
    rows.flatMap(row => {
      const skill = WorkspaceSkillSchema.safeParse(row)
      return skill.success ? [skill.data] : []
    }),
  ),
})
export type WorkspaceSkillsListing = z.infer<typeof WorkspaceSkillsListingSchema>

export const WorkspaceSkillsListQuerySchema = CollectionPageQuerySchema.extend({
  cwd: SafeRelativePathSchema.optional(),
})
export type WorkspaceSkillsListQuery = z.infer<typeof WorkspaceSkillsListQuerySchema>

export const WorkspaceSkillsPageSchema = collectionPageSchema(WorkspaceSkillSchema)
export type WorkspaceSkillsPage = z.infer<typeof WorkspaceSkillsPageSchema>
