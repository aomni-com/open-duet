'use client'

/* ============================================================================
   Where an open document's header goes.

   The document owns its header — the name, the size, save, history, download,
   the markdown toggle — because every one of those reads or writes state that
   lives inside `PreviewPane`: the accepted snapshot, the draft, whether a save
   is in flight. Lifting the markup out would mean lifting all of that with it.

   What the document does *not* own is where that header lands. Standing beside
   a listing, the drive already has a row of chrome — the control strip — and a
   document header under it makes two stacked bars over two panes, with two
   horizontal rules meeting at the divider between them. Holding the whole
   region there is no strip to share, so the header sits where it always did.

   So placement is the surface's decision and the header is the document's, and
   this is the seam between them: the surface offers an element, the document
   renders into it if there is one. No slot, no portal, no change.
   ========================================================================= */
import { createContext, useContext } from 'react'

/**
 * The offer: an element to render into, or nothing.
 *
 * One shape wherever it is taken up. The header always lands *in* the drive's
 * strip and takes the room left over in it, because the strip is one row: the
 * trail is at its left saying which folder, the header carries the file's own
 * name and controls, and the drive's remaining controls close the row.
 */
export type DocumentHeaderSlot = {
  element: HTMLElement | null
}

const DocumentHeaderSlotContext = createContext<DocumentHeaderSlot>({
  element: null,
})

export const DocumentHeaderSlotProvider = DocumentHeaderSlotContext.Provider

/** Where an open document should render its header, if the surface offers one. */
export function useDocumentHeaderSlot(): DocumentHeaderSlot {
  return useContext(DocumentHeaderSlotContext)
}
