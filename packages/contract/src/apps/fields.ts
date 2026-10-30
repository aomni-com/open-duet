import { z } from 'zod'

import { utf8BoundedString } from '../utf8/index'

export const MAX_APP_NAME_UTF8_BYTES = 192
export const AppNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .pipe(utf8BoundedString(MAX_APP_NAME_UTF8_BYTES, 'App name'))

// These are server-projected controls, shared by full apps and app summaries.
export const AppControlsSchema = z.object({
  manageDomain: z.boolean(),
  updateRuntime: z.boolean(),
  makePublic: z.boolean(),
  makePrivate: z.boolean(),
  delete: z.boolean(),
})
export type AppControls = z.infer<typeof AppControlsSchema>
