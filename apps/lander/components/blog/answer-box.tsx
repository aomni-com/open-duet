type AnswerBoxProps = {
  title?: string
  summary: string
  bullets?: string[]
  queries?: string[]
  faq?: Array<{ question: string; answer: string }>
}

export function AnswerBox({
  title = 'AI Search Answer Box',
  summary,
  bullets = [],
  queries = [],
  faq = [],
}: AnswerBoxProps) {
  const faqSchema = faq.length
    ? {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: faq.map(item => ({
          '@type': 'Question',
          name: item.question,
          acceptedAnswer: {
            '@type': 'Answer',
            text: item.answer,
          },
        })),
      }
    : null

  return (
    <section className="bg-lv2-surface-alt my-8 rounded-2xl border border-lv2-line p-6">
      <div className="flex items-center justify-between gap-4">
        <p className="text-lv2-muted text-sm uppercase tracking-[0.2em]">{title}</p>
        <span className="bg-lv2-surface text-lv2-muted rounded-full border border-lv2-line px-3 py-1 text-xs">
          Updated for AI discovery
        </span>
      </div>

      <p className="text-lv2-fg mt-4 text-lg">{summary}</p>

      {bullets.length > 0 && (
        <ul className="text-lv2-fg-soft mt-4 space-y-2 text-sm">
          {bullets.map(item => (
            <li key={item} className="flex gap-2">
              <span className="bg-lv2-accent mt-1 h-1.5 w-1.5 shrink-0 rounded-full" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}

      {queries.length > 0 && (
        <div className="mt-5">
          <p className="text-lv2-muted text-xs uppercase tracking-[0.2em]">
            Questions this page answers
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {queries.map(query => (
              <span
                key={query}
                className="bg-lv2-surface text-lv2-fg-soft rounded-full border border-lv2-line px-3 py-1 text-xs"
              >
                {query}
              </span>
            ))}
          </div>
        </div>
      )}

      {faqSchema && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
        />
      )}
    </section>
  )
}
