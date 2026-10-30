// Inline `style` pointer used on display headlines across the marketing
// surface. The full landing design system lives in `landing-styles.css`,
// imported once by `LandingChrome`. This file stays as the canonical
// home of the `serifStyle` constant so the 16+ existing imports keep
// working unchanged.
//
// The brand display face (Vollkorn) is loaded in `app/layout.tsx` as
// `--font-display`, so this constant carries no font runtime and is
// safe to import from anywhere.

export const serifStyle = { fontFamily: 'var(--font-display), Georgia, serif' } as const
