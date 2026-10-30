import { z } from 'zod'

import { utf8BoundedString } from '../utf8/index'

export const MAX_WORKSPACE_NAME_LENGTH = 200
export const MAX_WORKSPACE_NAME_UTF8_BYTES = 600
export const WorkspaceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_WORKSPACE_NAME_LENGTH)
  .pipe(utf8BoundedString(MAX_WORKSPACE_NAME_UTF8_BYTES, 'Workspace name'))
