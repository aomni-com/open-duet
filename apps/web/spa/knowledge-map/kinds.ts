/* ============================================================================
   The four things an agent is made of, in one exhaustive table.

   Jobs, skills, files and apps used to be enumerated in nine places — the fan
   order, the cell size, the icon, the field name on `Agent`, which viewer
   opens, the hint line, two CSS selector groups, and a numeric index that only
   the stylesheet knew the meaning of. `Record<KindKey, …>` makes a forgotten
   key a compile error instead.

   Only one of the four is on the ring now: an agent carries its apps and
   nothing else. The other three are what the zoom is made of, so the four still
   share an order, an icon and a hue — the tabs inside an agent and the warm
   points inside the core both read off this.

   The icon lives with the components in map-glyphs.tsx rather than here, since
   this module has to stay free of JSX to be callable from the layout and its
   tests — but that map is keyed the same way, so it is exhaustive too.
   ========================================================================= */
import type { KindKey } from './types'

/**
 * The order the four are always presented in: what it has been asked to do,
 * what it knows, what it keeps, what it can reach. The core's warm points cycle
 * through this and the zoom's tabs are laid out in it, so it is the one place
 * that order is decided.
 */
export const KIND_ORDER = ['jobs', 'skills', 'files', 'apps'] as const satisfies readonly KindKey[]
