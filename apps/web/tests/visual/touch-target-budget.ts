/* How many controls in the product are still too small for a finger.

   A number, checked in, that may only ever go down. `touch-targets.spec.ts`
   counts the real thing and fails when the count exceeds this — and equally
   expects you to lower this when a pass fixes some, because a budget nobody
   lowers is a budget nobody reads.

   It is deliberately one number rather than a list of exempt selectors. A list
   invites an entry per control and then an argument per entry; a number cannot
   be argued with and cannot quietly grow.

   The floor is 44px, which is what both mobile platforms specify. A control may
   also pass at 32px when nothing else interactive is within 8px of it — a lone
   icon in its own corner is hittable and a row of three is not. */
export const TOUCH_TARGET_BUDGET = 54
