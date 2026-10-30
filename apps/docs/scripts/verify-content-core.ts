import path from 'node:path'

export function routeFromMdxPath(relativePath: string): string {
  const normalized = relativePath.split(path.sep).join('/')
  if (normalized === 'app/page.mdx') return '/'
  return `/${normalized.replace(/^app\//, '').replace(/\/page\.mdx$/, '')}`
}

export function headingAnchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[`_*]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}
