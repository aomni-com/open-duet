# tailwind-config

This package owns Duet's shared visual tokens, Tailwind plugins, and dependency-free breakpoint values. Runtime hooks import the plain screen map; they never evaluate Tailwind's build configuration in the browser.

Standard shadcn color variables store OKLCH channels rather than complete color values, so
Tailwind opacity modifiers remain composable. Consume them through
`oklch(var(--token) / <alpha-value>)`; Duet-only brand and status variables remain HSL channels.

App-specific content paths or marketing utilities belong in the consuming app unless every Duet surface shares the same contract.
