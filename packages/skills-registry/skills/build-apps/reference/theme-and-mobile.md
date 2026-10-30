# Theme and Mobile

Load this reference for every app with a human-facing UI.

## Theme Override

Add this as the first script in `<head>`, before stylesheets, so the first paint
uses the requested theme:

```html
<script>
  ;(function () {
    var theme = new URLSearchParams(location.search).get('theme')
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.dataset.theme = theme
    }
  })()
</script>
```

Define light values by default. Let the operating-system preference select dark
only when `theme=light` has not forced light, and let `theme=dark` force dark:

```css
:root {
  --background: #ffffff;
  --foreground: #171717;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    --background: #111111;
    --foreground: #f5f5f5;
  }
}

html[data-theme='dark'] {
  --background: #111111;
  --foreground: #f5f5f5;
}
```

## Mobile Checklist

Put this in `<head>`:

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
```

Use border-box sizing globally:

```css
*,
*::before,
*::after {
  box-sizing: border-box;
}
```

- Give top-level containers `width: 100%` plus an appropriate `max-width`;
  avoid fixed page widths.
- Make charts and canvases resize with their containers.
- Collapse columns with responsive grid rules or explicit breakpoints.
- Keep interactive targets at least 40 px in both dimensions.
- At 400 px and 360 px, verify readable content, reachable controls, no
  horizontal scrolling, and safe-area padding where content meets an edge.
