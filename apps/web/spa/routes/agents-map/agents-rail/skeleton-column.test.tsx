/* The cold-landing column borrows the loaded roster's dimensions and rows.
   These checks pin that rendered wiring; browser screenshots own geometry. */
import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { ROSTER_HEAD_BOX, ROSTER_WIDTH } from './index'
import { RosterSkeletonColumn } from './skeleton-column'

const render = () => renderToStaticMarkup(<RosterSkeletonColumn />)

/* Width and shell offset are borrowed from the real column. The mode switch,
   Map row, section label and compact rows then reserve the same vertical bands
   the loaded navigator owns, so identity can land without shifting the map. */
test('it renders the real column’s shared width and head classes', () => {
  const markup = render()
  expect(markup).toContain(ROSTER_WIDTH)
  expect(markup).toContain(ROSTER_HEAD_BOX)
  expect(markup).toContain('data-build-sidebar-skeleton=""')
})

/* Five rows, because the real list draws five bars and a list that lands with a
   different count is its own jump. */
test('it draws the roster’s own waiting rows', () => {
  expect(render().split('<li').length - 1).toBe(5)
})

/* Out of the accessibility tree entirely: it is furniture standing in for
   content, and a screen reader announcing five empty rows is worse than
   silence. */
test('it is not announced', () => {
  expect(render().match(/<aside[^>]*>/)?.[0]).toContain('aria-hidden="true"')
})
