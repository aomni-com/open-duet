import type { Metadata } from 'next'
import { setRequestLocale } from 'next-intl/server'

import { Link } from '@/i18n/navigation'
import { localeMetadata } from '@/lib/i18n/locales'
import { LANDER_ORIGIN } from '@/lib/i18n/metadata'
import { SUPPORT_EMAIL } from '@/lib/public-site-config'

const englishMetadata: Metadata = {
  title: 'Data Protection — Duet',
  description:
    'Security and privacy are foundational to how Duet is built. Learn how we keep your data safe at every layer.',
  alternates: {
    canonical: `${LANDER_ORIGIN}/data-protection`,
    languages: {
      en: `${LANDER_ORIGIN}/data-protection`,
      [localeMetadata['es-419'].hreflang]: `${LANDER_ORIGIN}/es/data-protection`,
      'x-default': `${LANDER_ORIGIN}/data-protection`,
    },
  },
}

const pageCopy = {
  en: {
    back: 'Back to Home',
    title: 'How Duet Protects Your Data',
    intro:
      'Security and privacy are foundational to how Duet is built. Here is how we protect data across the service.',
    contact: 'Have more questions about how we handle your data? Reach out at',
    questions: [
      {
        question: 'How is my data stored on Duet?',
        answer:
          'Duet stores account, workspace, session, and billing metadata in its managed control plane. Each workspace also receives a dedicated cloud VM for its files and agent processes. Workspace credentials are scoped to that workspace, and the product API enforces membership and role checks before data is returned or changed.',
      },
      {
        question: 'What cloud providers does Duet use?',
        answer:
          'Duet uses several specialized providers: Convex for managed application data, Vercel for the web and API delivery layer, and exe.dev for dedicated workspace VMs. Model providers and optional integrations process only the requests needed when you use those services.',
      },
      {
        question: 'Who can access my Duet workspace?',
        answer:
          'Authenticated workspace members can access data according to their role. API keys and integration connections work only with the capabilities and workspace you authorize. Internal administrative access is separately restricted and audited.',
      },
      {
        question: 'Can AI model providers train on my data?',
        answer:
          'Duet does not use your workspace content to train its own models. Requests sent to a selected model provider are governed by that provider\u2019s commercial API terms and data controls, so you should review the terms for the models you choose.',
      },
      {
        question: 'Can infrastructure providers access my data?',
        answer:
          'Infrastructure providers operate the systems that store or transmit data under their own security controls and contractual terms. Duet limits each provider to the role it performs and isolates workspace files and processes in a dedicated VM rather than a shared workspace runtime.',
      },
      {
        question: 'Can Duet operators see my data?',
        answer:
          'Duet systems process workspace content to run the service. Authorized operators may access limited data when needed for support, security, abuse prevention, or reliable operation, subject to access controls and audit records. Duet does not sell or rent your workspace content.',
      },
      {
        question: 'Is my data encrypted?',
        answer:
          'Duet uses TLS for data in transit and the at-rest protections supplied by its managed infrastructure providers. Browser session credentials stay in secure, HTTP-only cookies; workspace and VM credentials are scoped and time-bounded; integration credentials remain on server-side provider boundaries rather than being exposed to browser JavaScript.',
      },
      {
        question: 'Can I delete my data?',
        answer: `You can delete individual sessions, apps, files, training records, and other supported resources from the product. You can also disconnect integrations to revoke future access. For account, workspace, or broader data deletion requests, contact ${SUPPORT_EMAIL}.`,
      },
    ],
  },
  'es-419': {
    back: 'Volver al inicio',
    title: 'Cómo protege Duet tus datos',
    intro:
      'La seguridad y la privacidad son parte fundamental de Duet. Así protegemos los datos en todo el servicio.',
    contact: '¿Tienes más preguntas sobre cómo manejamos tus datos? Escríbenos a',
    questions: [
      {
        question: '¿Cómo almacena Duet mis datos?',
        answer:
          'Duet almacena los metadatos de cuentas, workspaces, sesiones y facturación en su plano de control administrado. Cada workspace también recibe una VM dedicada en la nube para sus archivos y procesos del agente. Las credenciales están limitadas a ese workspace, y la API del producto verifica la membresía y el rol antes de devolver o cambiar datos.',
      },
      {
        question: '¿Qué proveedores de nube usa Duet?',
        answer:
          'Duet usa varios proveedores especializados: Convex para los datos administrados de la aplicación, Vercel para la capa web y de API, y exe.dev para las VMs dedicadas de los workspaces. Los proveedores de modelos y las integraciones opcionales procesan únicamente las solicitudes necesarias cuando usas esos servicios.',
      },
      {
        question: '¿Quién puede acceder a mi workspace de Duet?',
        answer:
          'Los miembros autenticados pueden acceder a los datos según su rol. Las API keys y conexiones de integraciones funcionan únicamente con las capacidades y el workspace que autorizas. El acceso administrativo interno está restringido y auditado por separado.',
      },
      {
        question: '¿Los proveedores de modelos pueden entrenar con mis datos?',
        answer:
          'Duet no usa el contenido de tu workspace para entrenar modelos propios. Las solicitudes enviadas al proveedor de modelos que elijas se rigen por sus términos de API comercial y sus controles de datos; revisa los términos de los modelos que uses.',
      },
      {
        question: '¿Los proveedores de infraestructura pueden acceder a mis datos?',
        answer:
          'Los proveedores de infraestructura operan los sistemas que almacenan o transmiten datos bajo sus propios controles de seguridad y términos contractuales. Duet limita a cada proveedor a la función que cumple y aísla los archivos y procesos de cada workspace en una VM dedicada, no en un entorno compartido.',
      },
      {
        question: '¿Los operadores de Duet pueden ver mis datos?',
        answer:
          'Los sistemas de Duet procesan el contenido del workspace para prestar el servicio. Los operadores autorizados pueden acceder a datos limitados cuando sea necesario para soporte, seguridad, prevención de abuso u operación confiable, sujeto a controles de acceso y registros de auditoría. Duet no vende ni alquila el contenido de tu workspace.',
      },
      {
        question: '¿Mis datos están cifrados?',
        answer:
          'Duet usa TLS para los datos en tránsito y las protecciones en reposo de sus proveedores de infraestructura administrada. Las credenciales de sesión del navegador permanecen en cookies seguras y HTTP-only; las credenciales del workspace y de la VM tienen alcance y duración limitados; y las credenciales de integraciones permanecen en fronteras del servidor, sin exponerse al JavaScript del navegador.',
      },
      {
        question: '¿Puedo eliminar mis datos?',
        answer: `Puedes eliminar sesiones, apps, archivos, registros de entrenamiento y otros recursos compatibles desde el producto. También puedes desconectar integraciones para revocar el acceso futuro. Para eliminar una cuenta, un workspace o un conjunto más amplio de datos, escribe a ${SUPPORT_EMAIL}.`,
      },
    ],
  },
} as const

type Props = { params: Promise<{ locale: 'en' | 'es-419' }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params
  if (locale === 'es-419') {
    return {
      title: 'Protección de datos — Duet',
      description:
        'La seguridad y la privacidad son la base de Duet. Conoce cómo mantenemos tus datos protegidos en cada capa.',
      robots: { index: false, follow: true },
      alternates: {
        canonical: `${LANDER_ORIGIN}/es/data-protection`,
        languages: {
          en: `${LANDER_ORIGIN}/data-protection`,
          [localeMetadata['es-419'].hreflang]: `${LANDER_ORIGIN}/es/data-protection`,
          'x-default': `${LANDER_ORIGIN}/data-protection`,
        },
      },
      openGraph: {
        title: 'Protección de datos — Duet',
        description:
          'La seguridad y la privacidad son la base de Duet. Conoce cómo mantenemos tus datos protegidos en cada capa.',
        url: `${LANDER_ORIGIN}/es/data-protection`,
        siteName: 'Duet',
        type: 'website',
        locale: localeMetadata['es-419'].ogLocale,
      },
    }
  }
  return englishMetadata
}

export default async function DataProtection({ params }: Props) {
  const { locale } = await params
  setRequestLocale(locale)
  const copy = pageCopy[locale]

  return (
    <div className="dark relative min-h-screen flex flex-col bg-black text-white">
      <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <Link
          href="/"
          className="inline-flex items-center text-sm text-gray-400 hover:text-white transition-colors mb-8"
        >
          &larr; {copy.back}
        </Link>

        <h1 className="text-4xl font-bold mb-4">{copy.title}</h1>

        <p className="text-lg text-gray-300 mb-12">{copy.intro}</p>

        <div className="space-y-12">
          {copy.questions.map(item => (
            <section key={item.question}>
              <h2 className="text-2xl font-semibold text-white mb-4">{item.question}</h2>
              <p className="text-gray-300 leading-relaxed">{item.answer}</p>
            </section>
          ))}
        </div>

        <div className="mt-16 pt-8 border-t border-white/10">
          <p className="text-sm text-gray-400">
            {copy.contact}{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="text-white hover:underline">
              {SUPPORT_EMAIL}
            </a>
          </p>
        </div>
      </div>
    </div>
  )
}
