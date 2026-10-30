import { Text } from 'react-email'

import { EmailShell, paragraphStyle } from './email-shell'

export const AUTH_MAGIC_LINK_SUBJECT = 'Sign in to Duet'
export const AUTH_MAGIC_LINK_PREVIEW = 'Use your secure link to return to Duet.'

/**
 * Two variants, and only one action each.
 *
 * A browser sign-in gets the link it always got. A sign-in an agent started
 * gets the code and **no button** — because the two would redeem the same
 * single-use token. `verifyCodeAndSignIn` deletes a correct code on success, so
 * a reader who clicked the button first would sign their browser in and leave
 * the agent's verify call to fail against a code that no longer exists; a
 * reader who read the code back first would find the button dead. Offering both
 * reads as "pick either", and they are rivals, not alternatives.
 *
 * This email is also the only place a human on the agent rail is told what they
 * are granting — that rail has no approval screen. So the copy states the scope,
 * the lifetime, that the code must not be shared, and how to take it back. None
 * of it is set in a quiet style: an unprimed review of an earlier draft found
 * the revocation line at roughly 3:1 while the sentence granting account-wide
 * power sat at near-black.
 */
export function AuthMagicLinkEmail({
  actionUrl,
  code,
  clientName,
  expiresInMinutes,
}: {
  actionUrl: string
  code?: string
  clientName?: string
  expiresInMinutes?: number
}) {
  const expiry =
    expiresInMinutes === undefined
      ? 'It expires shortly after it was requested.'
      : `It expires in ${expiresInMinutes} minutes.`

  if (code === undefined) {
    return (
      <EmailShell
        preview={AUTH_MAGIC_LINK_PREVIEW}
        greeting="there"
        actionUrl={actionUrl}
        actionLabel="Sign in to Duet"
        footer="This sign-in link was requested for this address. If you weren't expecting it, you can safely ignore this email."
      >
        <Text style={paragraphStyle}>Use the secure link below to return to Duet. {expiry}</Text>
      </EmailShell>
    )
  }

  return (
    <EmailShell
      preview={AUTH_MAGIC_LINK_PREVIEW}
      greeting="there"
      footer="If you weren't expecting this, someone else may be trying to reach your account. Ignore this email and the code stops working on its own."
    >
      <Text style={paragraphStyle}>Your sign-in code:</Text>
      <Text style={codeStyle}>{code}</Text>
      <Text style={paragraphStyle}>
        {clientName === undefined ? 'A client' : clientName} asked to sign in as you. Once you give
        it this code, it can do anything you can do in Duet except administer your account. {expiry}
      </Text>
      <Text style={paragraphStyle}>
        Only read this code back to whatever you just asked to sign you in. Do not share it with
        anyone else. To disconnect it later, sign in to Duet and remove its key from your settings.
      </Text>
    </EmailShell>
  )
}

/**
 * Tracking is deliberately modest. Wider spacing looked better in isolation and
 * made the hyphen ambiguous — at 3px an unprimed reader read `RNP4-4Y37` as two
 * space-separated groups, which is a code they would then retype wrong.
 */
const codeStyle = {
  color: '#111111',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: '30px',
  fontWeight: 700,
  letterSpacing: '1px',
  lineHeight: '38px',
  margin: '0 0 18px',
}
