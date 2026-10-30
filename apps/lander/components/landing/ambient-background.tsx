/**
 * Page-long daylight atmosphere sitting behind every section below the hero.
 *
 * The lander palette is porcelain blue-white with deep blue ink and a rare
 * teal accent. The ambient layer is what keeps that canvas from reading as
 * a flat slab: a barely-perceptible gradient, two soft warm/cool blooms,
 * and a hint of paper grain so the page feels like printed editorial
 * rather than a software screenshot.
 *
 * All CSS — no shader, no client JS — so it paints immediately and does
 * not flash in on hydrate.
 */

const GRAIN_SVG = `<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.08 0 0 0 0 0.12 0 0 0 0 0.20 0 0 0 0.50 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>`

const GRAIN_URL = `url("data:image/svg+xml;utf8,${GRAIN_SVG}")`

export function AmbientBackground() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-[100vh] bottom-0 z-0 overflow-hidden"
    >
      {/* Base canvas — a very slow drift between two porcelain tints so the
          page doesn't read as one printed sheet. The contrast between
          stops is intentionally tiny; the effect should be felt, not seen. */}
      <div
        className="absolute inset-0"
        style={{
          background: `linear-gradient(
            to bottom,
            hsl(210 28% 96%) 0%,
            hsl(208 30% 97%) 30%,
            hsl(210 26% 95%) 60%,
            hsl(212 24% 94%) 100%
          )`,
        }}
      />

      {/* Soft daylight blooms — warm sunlight on one side, cool window
          light on the other. Low opacity, heavy blur; they should read
          as weather, not as orbs. */}
      <div
        className="absolute right-[-12%] top-[12%] h-[640px] w-[640px] rounded-full opacity-[0.45] blur-[140px]"
        style={{ background: 'radial-gradient(circle, hsl(38 90% 78%) 0%, transparent 65%)' }}
      />
      <div
        className="absolute left-[-10%] top-[40%] h-[720px] w-[720px] rounded-full opacity-[0.35] blur-[150px]"
        style={{ background: 'radial-gradient(circle, hsl(200 80% 82%) 0%, transparent 65%)' }}
      />
      <div
        className="absolute right-[-8%] top-[68%] h-[560px] w-[560px] rounded-full opacity-[0.30] blur-[130px]"
        style={{ background: 'radial-gradient(circle, hsl(160 60% 82%) 0%, transparent 65%)' }}
      />

      {/* Paper grain — a hint of fiber so the daylight reads like a
          printed page, not a backlit screen. Multiply blend keeps it
          inside the existing tints instead of brightening them. */}
      <div
        className="absolute inset-0 opacity-[0.08] mix-blend-multiply"
        style={{
          backgroundImage: GRAIN_URL,
          backgroundRepeat: 'repeat',
          backgroundSize: '300px 300px',
        }}
      />

      {/* Top fade — smooth the seam between the hero video and the page
          canvas so neither one hard-cuts. */}
      <div
        className="absolute inset-x-0 top-0 h-32"
        style={{
          background: 'linear-gradient(to bottom, hsl(210 28% 96% / 0) 0%, hsl(210 28% 96%) 100%)',
        }}
      />
    </div>
  )
}
