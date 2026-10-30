'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

import { DOCS_SECTIONS } from '../lib/docs'

export function DocsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const currentRoute = DOCS_SECTIONS.flatMap(section => section.routes).find(
    route => normalizePathname(pathname) === route.href,
  )
  return (
    <div className="site-shell">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <header className="site-header">
        <Link className="brand" href="/" aria-label="Duet developer documentation home">
          <span className="brand-mark" aria-hidden="true">
            D
          </span>
          <span>
            <strong>Duet</strong>
            <small>Developer docs</small>
          </span>
        </Link>
        <a className="api-origin" href="https://ctl.duet.so">
          ctl.duet.so
        </a>
      </header>
      <div className="mobile-nav-wrap">
        <details className="mobile-nav">
          <summary>
            <span>Browse documentation</span>
            <span className="mobile-current-page">{currentRoute?.title ?? 'Developer docs'}</span>
          </summary>
          <DocsNav pathname={pathname} />
        </details>
      </div>
      <div className="docs-frame">
        <aside className="sidebar">
          <DocsNav pathname={pathname} />
        </aside>
        <main id="content" className="content">
          <article className="prose">{children}</article>
          <footer className="page-footer">
            Endpoint facts come from the shared contract. Prose explains how to use them.
          </footer>
        </main>
      </div>
    </div>
  )
}

function DocsNav({ pathname }: { pathname: string }) {
  return (
    <nav aria-label="Documentation">
      {DOCS_SECTIONS.map(section => (
        <section className="nav-section" key={section.title}>
          <h2>{section.title}</h2>
          <ul>
            {section.routes.map(route => (
              <li key={route.href}>
                <Link
                  href={route.href}
                  aria-current={normalizePathname(pathname) === route.href ? 'page' : undefined}
                >
                  {route.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  )
}

function normalizePathname(pathname: string): string {
  return pathname === '/' ? pathname : pathname.replace(/\/$/, '')
}
