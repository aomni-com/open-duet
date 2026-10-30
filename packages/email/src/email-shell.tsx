import type { ReactNode } from 'react'
import { Body, Button, Container, Head, Hr, Html, Preview, Section, Text } from 'react-email'

export function EmailShell({
  preview,
  greeting,
  children,
  actionUrl,
  actionLabel,
  footer,
}: {
  preview: string
  greeting: string
  children: ReactNode
  /**
   * Omitted when the message has no browser action to offer. The sign-in email
   * drops it in its code variant: the button and the code redeem the same
   * single-use token, so offering both hands the reader two paths that destroy
   * each other.
   */
  actionUrl?: string
  actionLabel?: string
  footer: ReactNode
}) {
  return (
    <Html>
      <Head>
        <meta name="color-scheme" content="light only" />
        <meta name="supported-color-schemes" content="light" />
      </Head>
      <Preview>{preview}</Preview>
      <Body style={pageStyle}>
        <Container style={cardStyle}>
          <Section>
            <Text style={paragraphStyle}>Hey {greeting},</Text>
            {children}
            {actionUrl !== undefined && actionLabel !== undefined ? (
              <Button href={actionUrl} style={buttonStyle}>
                {actionLabel}
              </Button>
            ) : null}
            <Text style={paragraphStyle}>Duet</Text>
            <Hr style={ruleStyle} />
            <Text style={footerStyle}>{footer}</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

export const paragraphStyle = {
  color: '#333333',
  fontSize: '16px',
  lineHeight: '26px',
  margin: '0 0 18px',
}

export const quietStyle = {
  color: '#777777',
  fontSize: '14px',
  lineHeight: '22px',
  margin: '0 0 18px',
}

const pageStyle = {
  backgroundColor: '#f6f9fc',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu, Cantarell, "Helvetica Neue", sans-serif',
  margin: '0',
  padding: '30px 12px',
}

const cardStyle = {
  backgroundColor: '#ffffff',
  border: '1px solid #f0f0f0',
  borderRadius: '5px',
  boxSizing: 'border-box' as const,
  margin: '0 auto',
  maxWidth: '600px',
  padding: '28px 30px',
}

const buttonStyle = {
  backgroundColor: '#0b66ff',
  borderRadius: '5px',
  color: '#ffffff',
  display: 'inline-block',
  fontSize: '15px',
  fontWeight: 500,
  margin: '4px 0 8px',
  padding: '12px 20px',
  textAlign: 'center' as const,
  textDecoration: 'none',
}

const ruleStyle = {
  borderColor: '#eeeeee',
  margin: '26px 0 20px',
}

const footerStyle = {
  color: '#666666',
  fontSize: '13px',
  lineHeight: '20px',
  margin: '0',
}
