/**
 * The organic highlighter stroke: an angled, feathered background-image band
 * (a marker leaves slanted, soft ends) painted BEHIND the glyphs of an inline
 * element with `box-decoration-break: clone`, so the stroke wraps naturally
 * across lines and the text stays crisp on top. Blue is used only here, at
 * the live moment — consistent with the palette's rationing.
 */

// Ink pulled from a theme token (`--lv2-marker` H S L triplet) so the stroke is
// a calm blue on porcelain and a brighter, higher-alpha blue on the dark canvas.
// `--lv2-marker-boost` scales every alpha per theme.
function ink(alpha: number): string {
  return `hsl(var(--lv2-marker) / calc(${alpha} * var(--lv2-marker-boost)))`
}

// An angled, feathered highlighter band. `edge`/`body` are the alpha at the wet
// leading streak and the flatter middle — a marker is a touch darker where it
// starts and lands.
export function marker(edge: number, body: number): string {
  return (
    `linear-gradient(101deg,` +
    ` ${ink(0)} 0.6%,` +
    ` ${ink(edge)} 2.4%,` +
    ` ${ink(body)} 6%,` +
    ` ${ink(body)} 94%,` +
    ` ${ink(edge)} 97.6%,` +
    ` ${ink(0)} 99.4%)`
  )
}
