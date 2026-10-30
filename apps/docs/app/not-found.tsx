import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="not-found">
      <p className="eyebrow">404</p>
      <h1>That document does not exist</h1>
      <p>The API may have moved forward, but this link did not. Start again from the docs map.</p>
      <Link className="primary-link" href="/">
        View documentation
      </Link>
    </div>
  )
}
