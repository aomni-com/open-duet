/* ============================================================================
   What Escape means on the map.

   Leaving the agent is what Escape means when the agent is the outermost thing
   on screen — and only then. A dialog, a menu or a popover opened *inside* the
   unfolded surface answers it first, and the flight back to the ring is not
   also owed.

   Without this the map flew out from under every layer it hosts: one Escape
   dismissed the dialog *and* threw the reader back to the ring, which reads as
   the key doing two unrelated things at once. The surface hosts a conversation
   with its own composer, its own menus and its own quality dialog, so this was
   never hypothetical.

   ---- `defaultPrevented` is the signal, and the phase is what makes it true ----
   Radix's dismissable layer registers on the *document*, in the **capture**
   phase, and only for its highest layer; on Escape it calls `preventDefault()`
   and dismisses. Capture on the document runs before a bubble-phase listener on
   the window, so by the time the map is asked, a layer that answered has
   already said so.

   That ordering is load-bearing: the map's listener must stay on the **bubble**
   phase. Move it to capture — as the drive's own document takeover does, for
   its own reasons — and this reads `defaultPrevented` before Radix has set it,
   the check silently passes, and the two-things-at-once bug is back with the
   guard still in place and still looking correct.
   ========================================================================= */

/**
 * Whether this keypress is the reader asking to leave the agent.
 *
 * Takes the two fields that decide rather than a `KeyboardEvent`, so the rule
 * is testable without a DOM and without standing a dialog up in front of it.
 */
export function leavesAgent(event: Pick<KeyboardEvent, 'key' | 'defaultPrevented'>): boolean {
  return event.key === 'Escape' && !event.defaultPrevented
}
