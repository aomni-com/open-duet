'use client'

import '@/components/blog/syntax-highlighting.css'

import 'react-lowlight/common'

import powershell from 'highlight.js/lib/languages/powershell'
import Lowlight from 'react-lowlight'

// Register additional languages not in common bundle
Lowlight.registerLanguage('powershell', powershell)

type CodeHighlightProps = {
  code: string
  language?: string
}

export function CodeHighlight({ code, language }: CodeHighlightProps) {
  return (
    <div className="relative group my-6">
      <Lowlight
        value={code}
        // Lowlight renders `<pre><code class="hljs">…</code></pre>`. The shared
        // The blog syntax stylesheet gives `.hljs` the active foreground color, which is
        // dark in light mode and disappears against our dark code surface. Override the
        // inner `<code>` color so plain (un-tokenized) code stays readable.
        className="overflow-x-auto rounded-lg border border-lv2-line bg-[color:var(--lv2-code-bg)] p-4 text-[color:var(--lv2-code-fg)] [&>code]:!text-[color:var(--lv2-code-fg)]"
        markers={[]}
        language={language}
      />
    </div>
  )
}
