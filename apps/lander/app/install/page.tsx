import Link from 'next/link'

import { InstallCodeBlock } from '../../components/install-code-block'
import {
  cliInstallBlock,
  devicePairingBlock,
  emailSignInBlock,
  mcpConfigBlock,
} from '../../src/install-copy'
import { siteConfig } from '../../src/site-config'

export default function Page() {
  const config = siteConfig()
  return (
    <main className="min-h-screen bg-background px-6 py-16 text-foreground">
      <section className="mx-auto max-w-4xl">
        <p className="text-sm font-medium text-brand">Install Duet</p>
        <h1 className="mt-4 max-w-3xl text-5xl font-semibold tracking-[-0.04em] sm:text-7xl">
          Agent-readable setup, human-approved login.
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
          Two ways in — device pairing, or email sign-in. Both sign you in as the person. Your
          current workspace memberships and roles determine access.
        </p>
        <div className="mt-8 flex gap-3">
          <Link
            className="rounded-full bg-primary px-5 py-3 text-sm text-primary-foreground"
            href="/install.txt"
          >
            Open install.txt
          </Link>
          <Link className="rounded-full border px-5 py-3 text-sm" href="/">
            Back home
          </Link>
        </div>
        <section className="mt-20 border-t pt-12">
          <h2 className="text-3xl font-semibold tracking-[-0.03em]">Sign in: pick a door</h2>
          <p className="mt-2 max-w-2xl text-base leading-7 text-muted-foreground">
            First the CLI, which both doors end up using — door A signs in with it, door B checks
            its key with it.
          </p>
          <InstallCodeBlock block={cliInstallBlock()} />
          <p className="mt-8 max-w-2xl text-base leading-7 text-muted-foreground">
            Then choose the sign-in method that fits. Both save your human login for subsequent
            commands.
          </p>
          <Door
            title="Door A: device pairing"
            summary="Take this one when your human can open a browser: they approve a code you show them."
            block={devicePairingBlock(config)}
          />
          <div className="my-8 flex items-center gap-4" aria-hidden>
            <span className="h-px flex-1 bg-border" />
            <span className="text-sm font-semibold uppercase tracking-[0.2em] text-foreground">
              or
            </span>
            <span className="h-px flex-1 bg-border" />
          </div>
          <Door
            title="Door B: email sign-in"
            summary="Take this one when your human can read their email: they read a code back to you."
            block={emailSignInBlock(config)}
          />
        </section>
        <section className="mt-20 border-t pt-12">
          <h2 className="text-3xl font-semibold tracking-[-0.03em]">
            Connect MCP, from whichever door you took
          </h2>
          <p className="mt-2 max-w-2xl text-base leading-7 text-muted-foreground">
            Point an MCP client at the hosted server, reading the key the door already wrote. Never
            print it.
          </p>
          <InstallCodeBlock block={mcpConfigBlock(config)} />
        </section>
      </section>
    </main>
  )
}

/**
 * One of the two interchangeable sign-in paths. Both render identically, at a
 * heading level below the choice that contains them, so neither reads as the
 * real path with the other as its fallback.
 */
function Door({ title, summary, block }: { title: string; summary: string; block: string }) {
  return (
    <div className="mt-8">
      <h3 className="text-xl font-semibold tracking-[-0.02em]">{title}</h3>
      <p className="mt-2 max-w-2xl text-base leading-7 text-muted-foreground">{summary}</p>
      <InstallCodeBlock block={block} />
    </div>
  )
}
