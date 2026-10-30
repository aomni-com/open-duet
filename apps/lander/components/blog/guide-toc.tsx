import { Link } from '@/i18n/navigation'

type TOCItem = {
  number: number
  title: string
  href: string
}

type GuideTOCProps = {
  items: TOCItem[]
}

export function GuideTOC({ items }: GuideTOCProps) {
  return (
    <div className="my-10">
      <h2 className="text-2xl font-semibold mb-6">In this guide</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {items.map(item => (
          <Link
            key={item.number}
            href={item.href}
            className="group block p-4 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 hover:border-white/20 transition-all"
          >
            <span className="text-lv2-muted font-mono text-sm">
              {String(item.number).padStart(2, '0')}
            </span>
            <p className="text-lv2-fg-soft mt-1 text-base font-medium leading-tight transition-colors group-hover:text-[color:var(--lv2-fg)]">
              {item.title}
            </p>
          </Link>
        ))}
      </div>
    </div>
  )
}
