import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { AIMessage, AIReasoning, AITrace, AITool, AIToolStatusIcon } from './ai-elements'

test('message shell keeps semantic article props and content order', () => {
  const html = renderToStaticMarkup(
    <AIMessage aria-label="Message from Duet" data-message-role="agent">
      <span>first</span>
      <span>second</span>
    </AIMessage>,
  )

  expect(html).toContain('<article')
  expect(html).toContain('aria-label="Message from Duet"')
  expect(html.indexOf('first')).toBeLessThan(html.indexOf('second'))
})

test('tool status transitions from spinner to a plain check without changing its contract', () => {
  const running = renderToStaticMarkup(<AIToolStatusIcon status="running" label="running" />)
  const complete = renderToStaticMarkup(<AIToolStatusIcon status="complete" label="complete" />)

  expect(running).toContain('aria-label="running"')
  expect(running).toContain('animate-spin')
  expect(complete).toContain('aria-label="complete"')
  expect(complete).not.toContain('animate-spin')
  expect(complete).not.toContain('square')
})

test('tool disclosure preserves native keyboard semantics and optional payload', () => {
  const html = renderToStaticMarkup(
    <AITool name="bash" status="complete" statusLabel="complete">
      <pre>echo ok</pre>
    </AITool>,
  )

  expect(html).toContain('<details')
  expect(html).toContain('<summary')
  expect(html).toContain('echo ok')
})

test('reasoning disclosure keeps its preview and full content in one native part', () => {
  const html = renderToStaticMarkup(
    <AIReasoning title="Reasoning" preview="Compare the evidence." pendingLabel="working">
      <p>Compare the evidence in full.</p>
    </AIReasoning>,
  )

  expect(html).toContain('<details')
  expect(html).toContain('Compare the evidence.')
  expect(html).toContain('Compare the evidence in full.')
  expect(html).toContain('working')
})

test('trace groups ordered activity lines under one disclosure', () => {
  const html = renderToStaticMarkup(
    <AITrace title="Agent work" description="Check the evidence · read_report">
      <div data-agent-part-id="reasoning">Check the evidence</div>
      <div data-agent-part-id="tool">read_report</div>
    </AITrace>,
  )

  expect(html.match(/<details/g)).toHaveLength(1)
  expect(html.indexOf('reasoning')).toBeLessThan(html.indexOf('tool'))
  expect(html).toContain('Agent work')
})
