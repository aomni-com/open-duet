import { ActionRetrier } from '@convex-dev/action-retrier'

import { components } from './_generated/api'

export const retrier = new ActionRetrier(components.actionRetrier)
