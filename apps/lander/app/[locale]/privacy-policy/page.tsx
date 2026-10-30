import type { Metadata } from 'next'
import { setRequestLocale } from 'next-intl/server'

import { Link } from '@/i18n/navigation'
import { localeMetadata } from '@/lib/i18n/locales'
import { LANDER_ORIGIN } from '@/lib/i18n/metadata'
import { SUPPORT_EMAIL } from '@/lib/public-site-config'

const englishMetadata: Metadata = {
  title: 'Privacy Policy — Duet',
  description: 'How Duet collects, uses, and protects your data while using our services.',
  alternates: {
    canonical: `${LANDER_ORIGIN}/privacy-policy`,
    languages: {
      en: `${LANDER_ORIGIN}/privacy-policy`,
      [localeMetadata['es-419'].hreflang]: `${LANDER_ORIGIN}/es/privacy-policy`,
      'x-default': `${LANDER_ORIGIN}/privacy-policy`,
    },
  },
}

type Props = { params: Promise<{ locale: 'en' | 'es-419' }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params
  if (locale === 'es-419') {
    return {
      title: 'Política de privacidad — Duet',
      description: 'Cómo Duet recopila, usa y protege tus datos mientras usas nuestros servicios.',
      robots: { index: false, follow: true },
      alternates: {
        canonical: `${LANDER_ORIGIN}/es/privacy-policy`,
        languages: {
          en: `${LANDER_ORIGIN}/privacy-policy`,
          [localeMetadata['es-419'].hreflang]: `${LANDER_ORIGIN}/es/privacy-policy`,
          'x-default': `${LANDER_ORIGIN}/privacy-policy`,
        },
      },
      openGraph: {
        title: 'Política de privacidad — Duet',
        description:
          'Cómo Duet recopila, usa y protege tus datos mientras usas nuestros servicios.',
        url: `${LANDER_ORIGIN}/es/privacy-policy`,
        siteName: 'Duet',
        type: 'website',
        locale: localeMetadata['es-419'].ogLocale,
      },
    }
  }
  return englishMetadata
}

export default async function PrivacyPolicy({ params }: Props) {
  const { locale } = await params
  setRequestLocale(locale)

  return (
    <div className="dark relative min-h-screen flex flex-col bg-black text-white">
      <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <Link
          href="/"
          className="inline-flex items-center text-sm text-gray-400 hover:text-white transition-colors mb-8"
        >
          &larr; Back to Home
        </Link>

        <h1 className="text-4xl font-bold mb-8">Privacy Policy</h1>

        <div className="prose prose-invert max-w-none">
          <p className="text-lg text-gray-300 mb-8">
            How Duet collects, uses, and protects your data while using our services.
          </p>

          <p className="text-gray-300 mb-8">
            At Aomni, Inc, we take your privacy seriously and are committed to protecting your
            personal information. This Privacy Policy outlines how we collect, use, disclose, and
            safeguard your data when you access and use our website, mobile application, and cloud
            agent workspace services, including AI-powered tools, messaging, code execution, file
            storage, and related capabilities (collectively referred to as the &quot;Service&quot;).
            By using the Service, you agree to the terms of this Privacy Policy.
          </p>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">1. Information We Collect</h2>
            <p className="text-gray-300 mb-4">We collect the following types of information:</p>

            <p className="text-gray-300 mb-4">
              <strong>1.1. Account Information:</strong> When you register for an account or use our
              Service, you may provide us with personal information, including but not limited to
              your name, email address, organization name, and other contact details.
            </p>
            <p className="text-gray-300 mb-4">
              <strong>1.2. Your Content:</strong> Content you create, upload, store, or transmit
              through the Service, including code, files, applications, session events, AI prompts,
              and other materials created within your cloud workspace.
            </p>
            <p className="text-gray-300 mb-4">
              <strong>1.3. AI Interaction Data:</strong> When you use AI features, we process your
              prompts, code context, file contents, and other inputs necessary to generate AI
              outputs. See Section 3 for details on how this data is handled.
            </p>
            <p className="text-gray-300">
              <strong>1.4. Automatically Collected Information:</strong> When you access the
              Service, certain information may be collected automatically, including your IP
              address, browser type, device type, operating system, and other technical information.
              We may also use cookies and similar tracking technologies to collect data about your
              interactions with our Service.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">
              2. How We Use Your Information
            </h2>
            <p className="text-gray-300 mb-4">
              We use the information we collect for the following purposes:
            </p>
            <p className="text-gray-300 mb-4">
              <strong>2.1. Providing the Service:</strong> We use your information to create and
              manage your account, operate your cloud workspace, deliver AI features, execute code,
              store files, and provide customer support.
            </p>
            <p className="text-gray-300 mb-4">
              <strong>2.2. Improving the Service:</strong> We analyze aggregated and anonymized
              usage data to improve our Service, develop new features, and enhance user experience.
              We do not use Your Content or AI interaction data for AI model training (see Section
              3).
            </p>
            <p className="text-gray-300 mb-4">
              <strong>2.3. Communication:</strong> We may send you information about the Service,
              updates, and promotional materials. You can opt out of promotional communications at
              any time.
            </p>
            <p className="text-gray-300">
              <strong>2.4. Legal Requirements:</strong> We may use your data to comply with
              applicable legal obligations, such as responding to legal requests and enforcing our
              Terms of Service.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">3. AI Data Processing</h2>
            <p className="text-gray-300 mb-4">
              When you use our AI features, portions of Your Content (such as prompts, code context,
              and file contents) are transmitted to third-party large language model (LLM) providers
              to generate outputs. Our current AI providers include Anthropic, OpenAI, and Google.
            </p>
            <p className="text-gray-300 mb-4">
              <strong>3.1. No Training on Your Data:</strong> We do not use Your Content or AI
              outputs to train, develop, or improve AI or machine learning models. We maintain data
              processing agreements with our third-party AI providers that prohibit them from using
              your data for model training.
            </p>
            <p className="text-gray-300 mb-4">
              <strong>3.2. Data Transmitted to Providers:</strong> Only the content necessary to
              fulfill your AI request is transmitted to providers. This typically includes your
              prompt, relevant code context, and file contents that you reference or that are needed
              for the AI to complete its task.
            </p>
            <p className="text-gray-300">
              <strong>3.3. Provider Retention:</strong> Our AI providers may temporarily retain
              input and output data for a limited period (typically 30 days or less) solely for
              safety monitoring and abuse prevention, after which it is deleted. Providers do not
              use this data for model training.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">4. Cloud Workspace Data</h2>
            <p className="text-gray-300 mb-4">
              Each user or organization is provided with a persistent cloud server
              (&quot;sandbox&quot;) as part of the Service. The following applies to data within
              your workspace:
            </p>
            <p className="text-gray-300 mb-4">
              <strong>4.1. Storage and Isolation:</strong> Your workspace data is stored on cloud
              infrastructure hosted in the United States. Each workspace is isolated from other
              users&apos; workspaces.
            </p>
            <p className="text-gray-300 mb-4">
              <strong>4.2. Persistence:</strong> Files, code, and data within your workspace persist
              across sessions for the duration of your account. You are responsible for maintaining
              your own backups of critical data.
            </p>
            <p className="text-gray-300 mb-4">
              <strong>4.3. Deletion:</strong> Upon account termination, workspace data will be
              deleted immediately, except as required for backups or legal compliance.
            </p>
            <p className="text-gray-300">
              <strong>4.4. Access:</strong> We may access workspace contents when necessary to
              provide support, ensure service integrity, investigate abuse, or comply with legal
              obligations. We do not access workspace contents for any other purpose.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">5. Third-Party Integrations</h2>
            <p className="text-gray-300 mb-4">
              The Service supports optional integrations with third-party services (such as Google,
              GitHub, Linear, Slack, and others provided through third-party integration platforms)
              to enhance functionality. These integrations are activated only at your direction.
            </p>
            <p className="text-gray-300 mb-4">
              <strong>5.1. Google User Data:</strong> If you choose to connect a Google account, we
              may access your name, email address, and data from Google services you authorize (such
              as Gmail or Google Calendar). This data is used exclusively to provide the features
              you enable. We strictly adhere to the Google API Services User Data Policy, including
              the Limited Use requirements. We do not use Google user data to develop, improve, or
              train AI or ML models.
            </p>
            <p className="text-gray-300 mb-4">
              <strong>5.2. Other Integrations:</strong> When you connect other third-party services,
              we access only the data necessary to deliver the functionality you request. You can
              disconnect any integration at any time, after which no new data will be accessed from
              that service.
            </p>
            <p className="text-gray-300">
              <strong>5.3. AI Processing of Integration Data:</strong> When you instruct the AI to
              interact with connected services (e.g., reading emails, creating issues), the relevant
              data is transmitted to AI providers as described in Section 3. This occurs only in
              response to your explicit instructions.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">6. Data Sharing</h2>
            <p className="text-gray-300 mb-4">
              We do not sell, rent, or trade your personal information to third parties. We may
              share your information in the following circumstances:
            </p>
            <p className="text-gray-300 mb-4">
              <strong>6.1. Service Providers and Sub-Processors:</strong> We share information with
              third-party service providers who assist us in providing the Service, including cloud
              infrastructure providers, AI model providers, and analytics services.{' '}
            </p>
            <p className="text-gray-300 mb-4">
              <strong>6.2. Legal Requirements:</strong> We may share information in response to
              valid legal requests or to protect our rights, privacy, safety, or property.
            </p>
            <p className="text-gray-300">
              <strong>6.3. Business Transfers:</strong> In the event of a merger, acquisition, or
              sale of all or a portion of our assets, your data may be transferred as part of the
              transaction.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">7. Data Retention</h2>
            <p className="text-gray-300 mb-4">We retain your data for the following periods:</p>
            <ul className="list-disc pl-6 text-gray-300 space-y-2">
              <li>
                <strong>Account information:</strong> For the duration of your account.
              </li>
              <li>
                <strong>Workspace data (code, files, applications):</strong> For the duration of
                your account. Deleted within 30 days of account termination.
              </li>
              <li>
                <strong>AI interaction logs:</strong> Retained for up to 30 days for safety
                monitoring, then deleted.
              </li>
              <li>
                <strong>Billing and payment records:</strong> Retained for 7 years as required by
                tax and accounting regulations.
              </li>
              <li>
                <strong>Server and access logs:</strong> Retained for up to 90 days for security
                monitoring.
              </li>
              <li>
                <strong>Aggregated and anonymized analytics:</strong> May be retained indefinitely
                as this data does not contain personal information.
              </li>
            </ul>
            <p className="text-gray-300 mt-4">
              {`You may request deletion of your data at any time by emailing ${SUPPORT_EMAIL}.`}
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">8. Security Measures</h2>
            <p className="text-gray-300">
              We implement reasonable security measures to protect your personal information from
              unauthorized access, disclosure, alteration, and destruction, including encryption of
              data in transit and at rest. However, no method of data transmission over the Internet
              or electronic storage is entirely secure, and we cannot guarantee the absolute
              security of your information.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">9. Your Rights and Choices</h2>
            <p className="text-gray-300 mb-4">
              You have the following rights regarding your personal information:
            </p>
            <p className="text-gray-300 mb-4">
              <strong>9.1. Access and Update:</strong> You may access and update your account
              information at any time through the Service.
            </p>
            <p className="text-gray-300 mb-4">
              <strong>9.2. Data Export:</strong> You may export your workspace data at any time
              through the Service.
            </p>
            <p className="text-gray-300 mb-4">
              <strong>9.3. Deletion:</strong> You may request deletion of your personal data by
              contacting us. We will process your request in accordance with applicable law.
            </p>
            <p className="text-gray-300 mb-4">
              <strong>9.4. Communications:</strong> You can opt out of receiving promotional
              communications from us at any time.
            </p>
            <p className="text-gray-300 mb-4">
              <strong>9.5. Integration Control:</strong> You can connect or disconnect third-party
              integrations at any time through the Service settings.
            </p>
            <p className="text-gray-300">
              <strong>9.6. Account Deactivation:</strong> You can deactivate your account at any
              time by contacting us.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">
              10. California Privacy Rights
            </h2>
            <p className="text-gray-300 mb-4">
              If you are a California resident, you have additional rights under the California
              Consumer Privacy Act (CCPA) and the California Privacy Rights Act (CPRA), including:
            </p>
            <ul className="list-disc pl-6 text-gray-300 space-y-2">
              <li>The right to know what personal information we collect, use, and disclose.</li>
              <li>The right to request deletion of your personal information.</li>
              <li>
                The right to opt out of the sale or sharing of your personal information. We do not
                sell or share your personal information as defined under the CCPA/CPRA.
              </li>
              <li>The right to non-discrimination for exercising your privacy rights.</li>
            </ul>
            <p className="text-gray-300 mt-4">
              {`To exercise these rights, please contact us at ${SUPPORT_EMAIL}.`}
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">
              11. International Data Transfers
            </h2>
            <p className="text-gray-300">
              The Service is hosted in the United States. If you access the Service from outside the
              United States, your data will be transferred to and processed in the United States. By
              using the Service, you consent to this transfer. We take appropriate safeguards to
              ensure your data is protected in accordance with this Privacy Policy, regardless of
              where it is processed. If you are located in the European Economic Area (EEA), United
              Kingdom, or Switzerland, we rely on appropriate transfer mechanisms as required by
              applicable law.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">12. Children&apos;s Privacy</h2>
            <p className="text-gray-300">
              Our Service is not intended for children under the age of 13 (or 16 in the EEA). We do
              not knowingly collect personal information from children. If you believe we have
              collected personal information from a child, please contact us, and we will take
              appropriate action to delete such information.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">
              13. Changes to this Privacy Policy
            </h2>
            <p className="text-gray-300">
              We may update this Privacy Policy from time to time to reflect changes in our
              practices or for other operational, legal, or regulatory reasons. We will post the
              revised Privacy Policy with an updated effective date on our website. Material changes
              will be communicated to you via email or through the Service.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">14. Contact Us</h2>
            <p className="text-gray-300 mb-4">
              {`If you have any questions or concerns about this Privacy Policy or
              our data practices, please contact us at ${SUPPORT_EMAIL}.`}
            </p>
            <p className="text-gray-300">
              By using the Duet Service, you acknowledge that you have read, understood, and agree
              to be bound by this Privacy Policy.
            </p>
          </section>
        </div>

        <div className="mt-12 pt-8 border-t border-white/10">
          <p className="text-sm text-gray-400">Last updated: July 13, 2026</p>
        </div>
      </div>
    </div>
  )
}
