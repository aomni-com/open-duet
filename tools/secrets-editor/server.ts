// Local-only secrets editor. Decrypts .env.production / .env.staging with dotenvx,
// serves an edit UI, and writes CHANGED keys back (re-encrypting in place) so git
// diffs stay minimal. Dev tool — binds to localhost, never deploy it.
//
//   bun run secrets:edit
//
// Keys with the SAME decrypted value in both files show under a "Shared" tab and
// edit/add to both at once; keys unique to (or differing between) an env show under
// that env's tab. Reads/writes via the dotenvx CLI, using the same .env.keys as the
// rest of the tooling. No secrets are persisted anywhere else.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ENVS = ['production', 'staging'] as const
type EnvName = (typeof ENVS)[number]
type Scope = EnvName | 'shared'

const PORT = Number(process.env.PORT ?? 7788)
// Absolute so it still resolves when we run dotenvx with cwd set to the env-file dir.
const DOTENVX = resolve('node_modules/.bin/dotenvx')
export const KEY_RE = /^[A-Z_][A-Z0-9_]*$/

// Env-file dir is resolved per call (not cached) so tests can point at a throwaway
// fixture dir via SECRETS_EDITOR_DIR without racing module load. dotenvx reads/writes
// its .env.keys relative to cwd, so we run it *in* this dir and pass relative -f — that
// keeps the private-key file next to the env files instead of leaking to the repo root.
const dir = () => process.env.SECRETS_EDITOR_DIR ?? '.'

// Key names sit in plaintext in the env files (only values are encrypted), so we can
// list them without decrypting.
function fileKeys(): string[] {
  const keys = new Set<string>()
  for (const env of ENVS) {
    const file = join(dir(), `.env.${env}`)
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)
      if (m) keys.add(m[1])
    }
  }
  return [...keys]
}

// Run dotenvx with a scrubbed environment. Bun auto-loads .env.local, so the editor's
// process.env already holds these secrets — and dotenvx merges process.env, which both
// makes `get` return the env value over the file AND makes `set` silently skip a write
// whose new value already matches the env (exit 0, file untouched). Stripping the managed
// keys (plus any explicit extras, e.g. a brand-new key being added) makes the file the
// sole source of truth for both read and write.
const dotenvx = (args: string[], stripExtra: string[] = []) => {
  const env = { ...process.env }
  for (const k of [...fileKeys(), ...stripExtra]) delete env[k]
  return execFileSync(DOTENVX, args, { cwd: dir(), encoding: 'utf8', env })
}

// All decrypted key/values for an env, in file order, minus the dotenvx public-key line.
export function readEnv(env: EnvName): Record<string, string> {
  const raw = dotenvx(['get', '-f', `.env.${env}`, '--format', 'json'])
  const all = JSON.parse(raw) as Record<string, string>
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith('DOTENV_PUBLIC_KEY')) continue
    out[k] = v
  }
  return out
}

function readAll(): Record<EnvName, Record<string, string>> {
  return { production: readEnv('production'), staging: readEnv('staging') }
}

// Set a single key (re-encrypts in place). Value passed as an argv entry — multi-line safe.
// Strip the target key too: a brand-new key may not be in the file yet but can still be
// in process.env (from .env.local), which would make dotenvx skip the write.
export function setKey(env: EnvName, key: string, value: string): void {
  dotenvx(['set', key, value, '-f', `.env.${env}`], [key])
}

// Remove a key by dropping its line — dotenvx has no unset. Key names sit in plaintext
// in the file (only values are encrypted), so this never materializes a secret.
export function deleteKey(env: EnvName, key: string): boolean {
  const file = join(dir(), `.env.${env}`)
  const lines = readFileSync(file, 'utf8').split('\n')
  // Match the exact key: `FOO=` must not also hit `FOO_BAR=`.
  const kept = lines.filter(line => !line.startsWith(`${key}=`))
  if (kept.length === lines.length) return false // key not present
  writeFileSync(file, kept.join('\n'))
  return true
}

// Pure decision layer for a save: given the current decrypted values and the
// submitted edits/deletes, decide what to write, what to drop, and what to skip.
// A delete wins over an edit for the same key. Unchanged values are skipped so
// git stays quiet. Kept side-effect-free so it can be unit-tested without dotenvx.
export type ChangePlan = {
  toSet: { key: string; value: string }[]
  toDelete: string[]
  skipped: string[]
  invalid: string[]
}
export function planChanges(
  current: Record<string, string>,
  entries: Record<string, string>,
  deletes: string[],
): ChangePlan {
  const plan: ChangePlan = { toSet: [], toDelete: [], skipped: [], invalid: [] }
  const dropped = new Set<string>()
  for (const key of deletes) {
    if (!KEY_RE.test(key)) plan.invalid.push(key)
    else if (key in current) {
      plan.toDelete.push(key)
      dropped.add(key)
    }
  }
  for (const [key, value] of Object.entries(entries)) {
    if (dropped.has(key)) continue // queued for deletion — ignore any edit
    if (!KEY_RE.test(key)) plan.invalid.push(key)
    else if (current[key] === value)
      plan.skipped.push(key) // already this value
    else plan.toSet.push({ key, value })
  }
  return plan
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function isScope(v: string): v is Scope {
  return v === 'shared' || (ENVS as readonly string[]).includes(v)
}

// Apply one save request. Both edits and queued deletes arrive together and are
// committed to disk here — the UI holds them until the user clicks Save.
export function applySave(
  scope: Scope,
  entries: Record<string, string>,
  deletes: string[],
): { updated: string[]; deleted: string[]; errors: { key: string; message: string }[] } {
  // Shared edits/deletes hit both files; an env-specific one hits just that file.
  const targets: EnvName[] = scope === 'shared' ? ['production', 'staging'] : [scope]
  const current = readAll()

  const updated: string[] = []
  const deleted: string[] = []
  const errors: { key: string; message: string }[] = []

  // Plan per target so "skip unchanged" is decided against that file's real value.
  for (const env of targets) {
    const plan = planChanges(current[env], entries, deletes)
    for (const key of plan.invalid) errors.push({ key, message: 'invalid key name (A–Z, 0–9, _)' })
    for (const { key, value } of plan.toSet) {
      try {
        setKey(env, key, value)
        if (!updated.includes(key)) updated.push(key)
      } catch (e) {
        errors.push({ key, message: (e as Error).message.split('\n').pop() ?? 'set failed' })
      }
    }
    for (const key of plan.toDelete) {
      try {
        deleteKey(env, key)
        if (!deleted.includes(key)) deleted.push(key)
      } catch (e) {
        errors.push({ key, message: (e as Error).message.split('\n').pop() ?? 'delete failed' })
      }
    }
  }
  return { updated, deleted, errors }
}

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url)

  if (url.pathname === '/') {
    return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  }

  if (url.pathname === '/api/all' && req.method === 'GET') {
    try {
      return json(readAll())
    } catch (e) {
      return json(
        { error: `decrypt failed — is .env.keys present? (${(e as Error).message})` },
        500,
      )
    }
  }

  if (url.pathname === '/api/secrets' && req.method === 'POST') {
    const body = (await req.json()) as {
      scope?: string
      entries?: Record<string, string>
      deletes?: string[]
    }
    const scope = body.scope ?? ''
    if (!isScope(scope)) return json({ error: `unknown scope "${scope}"` }, 400)
    try {
      const { updated, deleted, errors } = applySave(scope, body.entries ?? {}, body.deletes ?? [])
      return json({ updated, deleted, errors, all: readAll() })
    } catch (e) {
      return json({ error: `decrypt failed (${(e as Error).message})` }, 500)
    }
  }

  return new Response('not found', { status: 404 })
}

if (import.meta.main) {
  if (!existsSync(DOTENVX)) {
    console.error('dotenvx binary not found — run `bun install` at the repo root first.')
    process.exit(1)
  }
  const server = Bun.serve({ port: PORT, hostname: '127.0.0.1', fetch: handle })
  const address = `http://127.0.0.1:${server.port}`
  console.log(`\n  🔐  Secrets editor  →  ${address}`)
  console.log(`      editing .env.production and .env.staging (decrypted via dotenvx)\n`)
  if (process.env.SECRETS_EDITOR_OPEN !== '0') {
    try {
      execFileSync('open', [address]) // macOS convenience; harmless if it fails
    } catch {
      /* not macOS / no browser — the URL above is enough */
    }
  }
}

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Duet · secrets editor</title>
<style>
  :root {
    --bg:#f5f7f6; --panel:#fff; --ink:#15201d; --muted:#5d6b66; --line:#dde4e1;
    --accent:#0b7d75; --accent-ink:#0b5c56;
    --dirty:#9a6a12; --dirty-soft:#f6ecd6; --ok:#2f7d47; --danger:#a33b34; --code:#eef2f1;
    --shared:#7a5ea8; --prod:#a33b34; --stg:#0b7d75;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0e1413; --panel:#161e1c; --ink:#e6ecea; --muted:#94a29e; --line:#26302e;
      --accent:#4bb3a9; --accent-ink:#7fd0c7;
      --dirty:#d6a44a; --dirty-soft:#2a2413; --ok:#6bbf85; --danger:#e0807a; --code:#1b2422;
      --shared:#a992d6; --prod:#e0807a; --stg:#4bb3a9;
    }
  }
  * { box-sizing:border-box; }
  body {
    margin:0; background:var(--bg); color:var(--ink); font-size:15px; line-height:1.5;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  }
  .wrap { max-width:760px; margin:0 auto; padding:2.2rem 1.2rem 5rem; }
  header { display:flex; align-items:center; gap:.7rem; margin-bottom:.3rem; }
  h1 { font-size:1.3rem; margin:0; letter-spacing:-0.01em; }
  .sub { color:var(--muted); font-size:.86rem; margin:0 0 1.4rem; }
  .tabs { display:inline-flex; background:var(--panel); border:1px solid var(--line); border-radius:9px; padding:.25rem; gap:.25rem; }
  .tab {
    font:inherit; font-size:.85rem; font-weight:600; border:0; cursor:pointer; border-radius:7px;
    padding:.4rem .95rem; background:transparent; color:var(--muted); font-family:ui-monospace,Menlo,monospace;
    display:inline-flex; align-items:center; gap:.4rem;
  }
  .tab .count { font-size:.68rem; opacity:.7; font-variant-numeric:tabular-nums; }
  .tab[aria-selected="true"] { color:#fff; }
  .tab[data-scope="shared"][aria-selected="true"] { background:var(--shared); }
  .tab[data-scope="production"][aria-selected="true"] { background:var(--prod); }
  .tab[data-scope="staging"][aria-selected="true"] { background:var(--stg); }
  .bar { display:flex; align-items:center; gap:.8rem; margin:1.2rem 0 .4rem; }
  .bar .spacer { margin-left:auto; }
  .hint { color:var(--muted); font-size:.8rem; margin:.2rem 0 .9rem; min-height:1.1em; }
  button.ghost {
    font:inherit; font-size:.8rem; background:var(--panel); color:var(--ink); border:1px solid var(--line);
    border-radius:7px; padding:.4rem .7rem; cursor:pointer;
  }
  button.ghost:hover { border-color:var(--accent); }
  button.save {
    font:inherit; font-size:.85rem; font-weight:600; background:var(--accent); color:#fff; border:0;
    border-radius:8px; padding:.5rem 1.1rem; cursor:pointer;
  }
  button.save:disabled, button.ghost:disabled { opacity:.45; cursor:default; }
  button.ghost:disabled:hover { border-color:var(--line); }
  .field { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:.7rem .85rem; margin:.5rem 0; transition:border-color .15s; }
  .field.dirty { border-color:var(--dirty); background:var(--dirty-soft); }
  .field.deleting { border-color:var(--danger); background:transparent; opacity:.6; }
  .field.deleting label { color:var(--danger); text-decoration:line-through; }
  .field label {
    display:flex; align-items:center; gap:.5rem; font-family:ui-monospace,Menlo,monospace;
    font-size:.76rem; font-weight:600; color:var(--accent-ink); letter-spacing:.02em; margin-bottom:.35rem;
  }
  .field.dirty label { color:var(--dirty); }
  .tag { font-size:.6rem; text-transform:uppercase; letter-spacing:.06em; border-radius:4px; padding:.05em .4em; border:1px solid currentColor; }
  .tag.chg { color:var(--dirty); }
  .tag.also { color:var(--muted); text-transform:none; letter-spacing:0; font-family:ui-monospace,Menlo,monospace; }
  .tag.del { color:var(--danger); }
  .tag.only { color:var(--muted); }
  .row { display:flex; gap:.5rem; align-items:stretch; }
  input, textarea {
    flex:1; font:inherit; font-family:ui-monospace,Menlo,monospace; font-size:.85rem; color:var(--ink);
    background:var(--code); border:1px solid var(--line); border-radius:7px; padding:.5rem .6rem; width:100%; resize:vertical;
  }
  input:focus, textarea:focus { outline:2px solid var(--accent); outline-offset:1px; }
  button.del {
    flex:0 0 auto; align-self:stretch; font:inherit; font-size:.9rem; line-height:1; background:var(--panel);
    color:var(--muted); border:1px solid var(--line); border-radius:7px; padding:0 .65rem; cursor:pointer; transition:border-color .15s, color .15s;
  }
  button.del:hover { border-color:var(--danger); color:var(--danger); }
  .masked { -webkit-text-security:disc; text-security:disc; }
  .placeholder input, .placeholder textarea { color:var(--muted); font-style:italic; }
  .addrow { display:flex; gap:.5rem; margin-top:1rem; }
  .addrow input { flex:0 0 auto; width:16rem; }
  .toast {
    position:fixed; left:50%; bottom:1.4rem; transform:translateX(-50%); background:var(--ink); color:var(--bg);
    padding:.6rem 1rem; border-radius:9px; font-size:.85rem; opacity:0; transition:opacity .2s; pointer-events:none;
  }
  .toast.show { opacity:1; }
  .toast.err { background:var(--danger); color:#fff; }
  .empty { color:var(--muted); font-size:.9rem; padding:2rem 0; text-align:center; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <span style="font-size:1.4rem">🔐</span>
    <h1>Duet secrets editor</h1>
  </header>
  <p class="sub">Decrypted from the committed dotenvx files. Edits and deletions are queued until you Save — then only changed keys are re-encrypted in place. Local only; nothing leaves this machine.</p>

  <div class="tabs" role="tablist">
    <button class="tab" role="tab" data-scope="shared" aria-selected="true">Shared <span class="count" data-count="shared"></span></button>
    <button class="tab" role="tab" data-scope="production" aria-selected="false">.env.production <span class="count" data-count="production"></span></button>
    <button class="tab" role="tab" data-scope="staging" aria-selected="false">.env.staging <span class="count" data-count="staging"></span></button>
  </div>

  <div class="bar">
    <button class="ghost" id="reveal">👁 Reveal values</button>
    <div class="spacer"></div>
    <button class="ghost" id="undo" disabled>↩ Undo</button>
    <button class="save" id="save" disabled>Save changes</button>
  </div>
  <p class="hint" id="hint"></p>

  <div id="fields"></div>

  <div class="addrow">
    <input id="newkey" placeholder="NEW_KEY_NAME" />
    <input id="newval" placeholder="value" />
    <button class="ghost" id="add">+ Add key</button>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
  let all = { production: {}, staging: {} }  // decrypted values from both files
  let scope = 'shared'                       // 'shared' | 'production' | 'staging'
  let loaded = {}                            // baseline entries for the active tab
  let masked = true

  const $ = (s) => document.querySelector(s)
  const fieldsEl = $('#fields')

  function toast(msg, isErr) {
    const t = $('#toast')
    t.textContent = msg
    t.className = 'toast show' + (isErr ? ' err' : '')
    setTimeout(() => (t.className = 'toast'), 2600)
  }

  // A key is shared when it exists in both files with an identical value.
  function sharedMap() {
    const s = {}
    for (const k of Object.keys(all.production))
      if (all.staging[k] !== undefined && all.staging[k] === all.production[k]) s[k] = all.production[k]
    return s
  }

  function baselineFor(sc) {
    if (sc === 'shared') return sharedMap()
    const shared = sharedMap(), src = all[sc], out = {}
    for (const k of Object.keys(src)) if (!(k in shared)) out[k] = src[k]  // unique-to or differing
    return out
  }

  function tagFor(key) {
    if (scope === 'shared') return ''
    const other = scope === 'production' ? 'staging' : 'production'
    return all[other][key] !== undefined ? 'diff' : 'only'  // in both but differing, vs unique here
  }

  function counts() {
    for (const el of document.querySelectorAll('[data-count]'))
      el.textContent = Object.keys(baselineFor(el.dataset.count)).length
  }

  function isDeleting(el) {
    return el.closest('.field').classList.contains('deleting')
  }

  // Edits for every non-deleted row (includes just-added rows).
  function currentEntries() {
    const out = {}
    for (const el of fieldsEl.querySelectorAll('[data-key]')) if (!isDeleting(el)) out[el.dataset.key] = el.value
    return out
  }

  // Keys marked for deletion that actually exist on disk (added-then-deleted rows drop out).
  function pendingDeletes() {
    const out = []
    for (const field of fieldsEl.querySelectorAll('.field.deleting')) {
      const key = field.querySelector('[data-key]').dataset.key
      if (key in loaded) out.push(key)
    }
    return out
  }

  function isDirty() {
    if (pendingDeletes().length) return true
    const cur = currentEntries()
    const keys = new Set([...Object.keys(loaded), ...Object.keys(cur)])
    for (const k of keys) if ((loaded[k] ?? null) !== (cur[k] ?? '')) return true
    return false
  }

  function refreshDirty() {
    for (const field of fieldsEl.querySelectorAll('.field')) {
      const el = field.querySelector('[data-key]')
      const deleting = field.classList.contains('deleting')
      const changed = !deleting && (loaded[el.dataset.key] ?? null) !== el.value
      field.classList.toggle('dirty', changed)
      field.querySelector('.tag.chg')?.style.setProperty('display', changed ? '' : 'none')
      field.querySelector('.tag.del')?.style.setProperty('display', deleting ? '' : 'none')
    }
    const dirty = isDirty()
    $('#save').disabled = !dirty
    $('#undo').disabled = !dirty
  }

  function fieldRow(key, value, tag) {
    const multiline = value.includes('\\n') || value.length > 60
    const control = multiline
      ? \`<textarea rows="\${Math.min(6, value.split('\\n').length + 1)}" data-key="\${key}"></textarea>\`
      : \`<input type="text" data-key="\${key}" />\`
    const placeholder = value === 'REPLACE_ME'
    const other = scope === 'production' ? 'staging' : 'production'
    const tagHtml = tag === 'diff'
      ? \`<span class="tag also" title="Also set in .env.\${other}, with a different value">also in .env.\${other}</span>\`
      : tag === 'only' ? '<span class="tag only">only here</span>' : ''
    return \`<div class="field\${placeholder ? ' placeholder' : ''}">
      <label>\${key}\${tagHtml}<span class="tag chg" style="display:none">changed</span><span class="tag del" style="display:none">will delete</span></label>
      <div class="row">\${control}<button class="del" data-del="\${key}" title="Delete \${key}" aria-label="Delete \${key}">🗑</button></div>
    </div>\`
  }

  function applyMask() {
    for (const el of fieldsEl.querySelectorAll('[data-key]')) el.classList.toggle('masked', masked)
    $('#reveal').textContent = masked ? '👁 Reveal values' : '🙈 Hide values'
  }

  function render() {
    loaded = baselineFor(scope)
    const keys = Object.keys(loaded)
    $('#hint').textContent = scope === 'shared'
      ? 'Keys identical in both files. Editing or adding here writes .env.production AND .env.staging.'
      : 'Keys unique to or differing from the other env. Editing here writes only .env.' + scope + '.'
    if (!keys.length) {
      fieldsEl.innerHTML = '<div class="empty">No keys here yet.</div>'
    } else {
      fieldsEl.innerHTML = keys.map((k) => fieldRow(k, loaded[k], tagFor(k))).join('')
      for (const el of fieldsEl.querySelectorAll('[data-key]')) {
        el.value = loaded[el.dataset.key]
        el.addEventListener('input', refreshDirty)
      }
    }
    counts()
    applyMask()
    refreshDirty()
  }

  async function loadAll() {
    fieldsEl.innerHTML = '<div class="empty">Decrypting…</div>'
    const res = await fetch('/api/all')
    const data = await res.json()
    if (data.error) { fieldsEl.innerHTML = '<div class="empty">⚠ ' + data.error + '</div>'; return }
    all = data
    render()
  }

  // Queue a deletion (or un-queue it) — nothing hits disk until Save.
  function toggleDelete(key) {
    const field = fieldsEl.querySelector('[data-del="' + key + '"]')?.closest('.field')
    if (!field) return
    // A key not in the baseline is an unsaved new row — drop it entirely, no queue needed.
    if (!(key in loaded)) {
      field.remove()
      if (!fieldsEl.querySelector('.field')) fieldsEl.innerHTML = '<div class="empty">No keys here yet.</div>'
      counts(); refreshDirty()
      return
    }
    const deleting = !field.classList.contains('deleting')
    field.classList.toggle('deleting', deleting)
    const input = field.querySelector('[data-key]')
    input.disabled = deleting
    const btn = field.querySelector('.del')
    btn.textContent = deleting ? '↩' : '🗑'
    btn.title = (deleting ? 'Keep ' : 'Delete ') + key
    refreshDirty()
  }

  async function save() {
    const btn = $('#save')
    const deletes = pendingDeletes()
    btn.disabled = true
    $('#undo').disabled = true
    btn.textContent = 'Saving…'
    const res = await fetch('/api/secrets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope, entries: currentEntries(), deletes }),
    })
    const data = await res.json()
    btn.textContent = 'Save changes'
    if (data.error) { toast(data.error, true); refreshDirty(); return }
    all = data.all
    render()
    const where = scope === 'shared' ? 'both files' : '.env.' + scope
    const parts = []
    if (data.updated.length) parts.push('saved ' + data.updated.length)
    if (data.deleted.length) parts.push('deleted ' + data.deleted.length)
    if (data.errors?.length) toast(data.errors.length + ' failed · ' + (parts.join(' · ') || 'no changes'), true)
    else if (!parts.length) toast('No changes')
    else toast(parts.join(' · ') + ' in ' + where)
  }

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      if (scope === tab.dataset.scope) return
      if (isDirty() && !confirm('Discard unsaved changes?')) return
      for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t === tab))
      scope = tab.dataset.scope
      render()
    })
  }
  fieldsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-del]')
    if (btn) toggleDelete(btn.dataset.del)
  })
  $('#save').addEventListener('click', save)
  $('#undo').addEventListener('click', () => {
    if (!isDirty()) return
    render()  // rebuild from baseline — discards edits, added rows, and queued deletes
    toast('Reverted changes')
  })
  $('#reveal').addEventListener('click', () => { masked = !masked; applyMask() })
  $('#add').addEventListener('click', () => {
    const key = $('#newkey').value.trim().toUpperCase()
    const val = $('#newval').value
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) return toast('Invalid key name', true)
    if (loaded[key] !== undefined || currentEntries()[key] !== undefined) return toast(key + ' already in this tab', true)
    fieldsEl.querySelector('.empty')?.remove()
    fieldsEl.insertAdjacentHTML('beforeend', fieldRow(key, val, ''))
    const el = fieldsEl.querySelector('[data-key="' + key + '"]')
    el.value = val
    el.addEventListener('input', refreshDirty)
    $('#newkey').value = ''; $('#newval').value = ''
    applyMask(); refreshDirty()
  })
  window.addEventListener('beforeunload', (e) => { if (isDirty()) e.preventDefault() })

  loadAll()
</script>
</body>
</html>`
