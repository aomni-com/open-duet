export type PausedPageLocale = 'en' | 'es-419'

export function renderPausedPage(appName: string, locale: PausedPageLocale): string {
  const spanish = locale === 'es-419'
  const name = escapeHtml(appName)
  const title = spanish ? `${name} está en pausa` : `${name} is paused`
  const body = spanish
    ? 'Esta app no está disponible ahora mismo. Vuelve a intentarlo pronto.'
    : 'This app isn’t available right now. Please check back soon.'
  const builtWith = spanish ? 'Creado con' : 'Built with'
  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · Duet</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #2a2723; background: #f4f0e8; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at 50% 38%, #fffdf8 0, #f4f0e8 58%, #e8e1d4 100%); }
    main { width: min(100%, 560px); text-align: center; }
    .brand { display: inline-flex; align-items: center; gap: 10px; margin-bottom: 52px; color: #625b50; font-size: 14px; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; }
    .mark { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 9px; color: #fffdf8; background: #29251f; font-family: Georgia, serif; font-size: 17px; letter-spacing: 0; text-transform: none; }
    .eyebrow { margin: 0 0 18px; color: #9b5f3b; font-size: 12px; font-weight: 750; letter-spacing: .14em; text-transform: uppercase; }
    h1 { margin: 0; font-family: Georgia, "Times New Roman", serif; font-size: clamp(38px, 8vw, 62px); font-weight: 500; line-height: 1.03; letter-spacing: -.035em; overflow-wrap: anywhere; }
    p { max-width: 420px; margin: 24px auto 0; color: #70685d; font-size: 17px; line-height: 1.65; }
    footer { margin-top: 64px; color: #8a8175; font-size: 13px; }
    footer strong { color: #4c463e; font-weight: 700; }
  </style>
</head>
<body>
  <main data-edge-paused-page>
    <div class="brand" data-edge-paused-brand><span class="mark" aria-hidden="true">D</span> Duet</div>
    <div class="eyebrow" data-edge-paused-status>${spanish ? 'App en pausa' : 'App paused'}</div>
    <h1 data-edge-paused-title>${title}</h1>
    <p data-edge-paused-body>${body}</p>
    <footer data-edge-paused-mark>${builtWith} <strong>Duet</strong></footer>
  </main>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => {
    if (character === '&') return '&amp;'
    if (character === '<') return '&lt;'
    if (character === '>') return '&gt;'
    if (character === '"') return '&quot;'
    return '&#39;'
  })
}
