export type BuildingPageFile = { path: string; mtimeMs: number }

export type BuildingPageModel = {
  name: string
  files: readonly BuildingPageFile[]
  nowMs: number
  refreshSeconds: number
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function relativeTimeLabel(nowMs: number, mtimeMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - mtimeMs) / 1_000))
  if (seconds < 60) return `${seconds}s ago`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  return `${Math.floor(hours / 24)}d ago`
}

const STYLES = `
  :root {
    color-scheme: light dark;
    --page: #f7f7f8;
    --surface: rgba(255, 255, 255, 0.76);
    --line: rgba(24, 24, 27, 0.09);
    --text: #202023;
    --muted: #727279;
    --placeholder: #e8e8eb;
    --shimmer: rgba(255, 255, 255, 0.72);
  }
  * { box-sizing: border-box; }
  html, body { min-height: 100%; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 48px 24px;
    background: var(--page);
    color: var(--text);
    font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main {
    width: min(100%, 640px);
    text-align: center;
  }
  .placeholder {
    position: relative;
    width: 76px;
    height: 76px;
    margin: 0 auto 26px;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 20px;
    background: var(--placeholder);
    box-shadow: 0 8px 28px rgba(24, 24, 27, 0.06);
  }
  .placeholder::after {
    position: absolute;
    inset: 0;
    content: "";
    background: linear-gradient(105deg, transparent 22%, var(--shimmer) 46%, transparent 70%);
    transform: translateX(-120%);
    animation: shimmer 1.8s ease-in-out infinite;
  }
  h1 {
    margin: 0;
    font-size: clamp(1.65rem, 5vw, 2rem);
    font-weight: 620;
    letter-spacing: -0.035em;
    line-height: 1.18;
    text-wrap: balance;
    overflow-wrap: anywhere;
  }
  .app-name { white-space: nowrap; }
  .message {
    margin: 12px auto 0;
    color: var(--muted);
    font-size: 0.96rem;
    line-height: 1.55;
  }
  .activity {
    max-width: 560px;
    margin: 42px auto 0;
    text-align: left;
  }
  .activity h2 {
    margin: 0 0 11px;
    color: var(--muted);
    font-size: 0.72rem;
    font-weight: 650;
    letter-spacing: 0.095em;
    text-transform: uppercase;
  }
  ul {
    margin: 0;
    padding: 5px 18px;
    list-style: none;
    border: 1px solid var(--line);
    border-radius: 16px;
    background: var(--surface);
    box-shadow: 0 12px 36px rgba(24, 24, 27, 0.035);
  }
  li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 18px;
    align-items: baseline;
    min-height: 45px;
    padding: 12px 0;
    border-bottom: 1px solid var(--line);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.79rem;
    line-height: 1.55;
  }
  li:last-child { border-bottom: 0; }
  li span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  time {
    color: var(--muted);
    font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 0.76rem;
    white-space: nowrap;
  }
  @keyframes shimmer {
    to { transform: translateX(120%); }
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --page: #111113;
      --surface: rgba(31, 31, 35, 0.72);
      --line: rgba(255, 255, 255, 0.085);
      --text: #f0f0f2;
      --muted: #929298;
      --placeholder: #28282c;
      --shimmer: rgba(255, 255, 255, 0.12);
    }
    .placeholder { box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2); }
    ul { box-shadow: 0 16px 42px rgba(0, 0, 0, 0.12); }
  }
  @media (max-width: 520px) {
    body { padding: 36px 18px; }
    .placeholder { width: 68px; height: 68px; border-radius: 18px; margin-bottom: 23px; }
    .activity { margin-top: 34px; }
    ul { padding-inline: 15px; border-radius: 14px; }
    li { gap: 12px; font-size: 0.75rem; }
    .file-path.has-directory { font-size: 0; }
    .file-path.has-directory::after {
      content: attr(data-mobile-path);
      font-size: 0.75rem;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .placeholder::after { animation: none; transform: none; opacity: 0.45; }
  }
`

export function renderBuildingPage(model: BuildingPageModel): string {
  const name = escapeHtml(model.name)
  const fileItems = model.files
    .slice(0, 6)
    .map(file => {
      const lastSlash = file.path.lastIndexOf('/')
      const pathClass = lastSlash >= 0 ? 'file-path has-directory' : 'file-path'
      const pathParts = file.path.split('/')
      const mobilePath = pathParts.length > 2 ? `…/${pathParts.slice(-2).join('/')}` : file.path
      return `<li><span class="${pathClass}" title="${escapeHtml(file.path)}" data-mobile-path="${escapeHtml(mobilePath)}">${escapeHtml(file.path)}</span><time>${relativeTimeLabel(model.nowMs, file.mtimeMs)}</time></li>`
    })
    .join('')
  const activity = fileItems
    ? `<section class="activity" aria-labelledby="activity-heading">
      <h2 id="activity-heading">Recent activity</h2>
      <ul>${fileItems}</ul>
    </section>`
    : ''
  const message = fileItems
    ? 'Recent changes are appearing here while your app gets ready.'
    : 'Waiting for the first file changes while your app gets ready.'

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="${model.refreshSeconds}">
  <title>${name} is being built</title>
  <style>${STYLES}</style>
</head>
<body>
  <main>
    <div class="placeholder" aria-hidden="true"></div>
    <h1><span class="app-name">${name}</span> is being built</h1>
    <p class="message">${message}</p>
    ${activity}
  </main>
</body>
</html>`
}
