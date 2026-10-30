import {
  type CopyCard,
  type IntegrationsCopy,
  MACHINE,
  type PrimitivesCopy,
  type SetupCopy,
  type ShareCopy,
} from '@/components/landing/landers/section-copy'
import type { AppLocale } from '@/lib/i18n/locales'

/**
 * Copy for the homepage, in every language it is served in.
 *
 * Kept out of the components because non-visual callers read it: the
 * homepage's metadata and JSON-LD, and the agent-readable text surfaces.
 * Importing a component to reach a string pulls the whole landing chrome
 * (and its image and video dependencies) into a text pipeline.
 *
 * The page sells one thing: one subscription that puts every kind of
 * state-of-the-art AI in reach of someone who will not assemble it
 * themselves. [positioning.md](../../../../../positioning.md) owns the
 * audience and the rules. The reader does not know what the state of the art
 * includes, so the page shows it (outcomes first, then the stack it replaces,
 * then the inventory) and never says it in engineering words. Every claim
 * below has a caller in the product; a capability with only an interface
 * behind it (selling on the marketplace, for one) does not belong here until
 * it ships.
 */

export type HomeCopy = {
  /** `<title>`, the WebPage name, and the agent-readable twin's heading. */
  title: string
  /** Meta description and the brand-level JSON-LD description. Short enough
   * that a results page does not truncate it. */
  description: string
  cta: string
  hero: { lead: string; trail: string; sub: string }
  /** Jobs a reader could hand over in their first week, each one a sentence. */
  outcomes: { eyebrow: string; title: string; intro: string; pillars: readonly CopyCard[] }
  setup: SetupCopy
  train: {
    eyebrow: string
    titleLead: string
    titleTrail: string
    intro: string
    feed: readonly string[]
    facetNotes: readonly string[]
  }
  platform: PrimitivesCopy
  share: ShareCopy
  integrations: IntegrationsCopy
  faq: { eyebrow: string; title: string; items: readonly { q: string; a: string }[] }
  close: {
    eyebrow: string
    titleLead: string
    titleMark: string
    sub: string
    bullets: readonly string[]
  }
  /** SoftwareApplication `featureList`: what the product does, one line each. */
  featureList: readonly string[]
}

const EN: HomeCopy = {
  title: 'Duet: Every Kind of AI in One Subscription, No Setup',
  description:
    'One subscription for the best AI in writing, images, video and voice, plus agents that browse, research, and work in your apps. Nothing to set up.',
  cta: 'Start free',
  hero: {
    lead: 'One subscription.',
    trail: 'Every kind of AI.',
    sub: 'Writing, images, video and voice from the best models, plus agents that browse the web, work in your apps, research people and companies, run on their own, and publish what they build. Nothing to install, nothing to configure.',
  },
  outcomes: {
    eyebrow: 'What you can hand it',
    title: 'Say what you need. Come back to it done.',
    intro:
      'A few things people ask for in their first week. Each one is a sentence, typed in plain language.',
    pillars: [
      {
        title: 'Research 40 prospects overnight',
        body: 'It finds the right people at the companies you name, looks up their contact details, and drafts a personal email to each one in your Gmail, ready for you to send.',
      },
      {
        title: 'Turn a product photo into a video ad',
        body: 'It writes the script, makes the footage from your photo, and adds a voiceover. You get a finished ad, not a list of tools to try.',
      },
      {
        title: 'Put a booking page online',
        body: 'It designs the page, writes the copy, and publishes it at a real link you can send to customers the same afternoon.',
      },
      {
        title: 'Watch competitor prices every morning',
        body: 'It visits their sites on a schedule, notes what changed since yesterday, and sends you a short summary before you start work.',
      },
      {
        title: 'Keep your inbox under control',
        body: 'It sorts what came in, drafts replies in your voice, and checks with you before anything goes out.',
      },
      {
        title: 'Turn a long call into next steps',
        body: 'Drop in the recording and get a summary, a follow-up email, and a task list your team can work from.',
      },
    ],
  },
  setup: {
    eyebrow: 'Why this used to take an engineer',
    title: 'The best AI isn’t one app. It’s a stack.',
    intro:
      'To get all of that on your own, you would wire together a dozen products and keep them working as new models arrive every month. Most people stop at a chatbot instead.',
    before: {
      label: 'Doing it yourself',
      items: [
        'Accounts with three or four AI companies, each with its own bill',
        'One tool for images, another for video, another for voice',
        'A research service for finding people and companies',
        'Software that lets an agent use websites',
        'A computer that stays on, so work runs overnight',
        'Hosting for anything the agent builds',
        'Rewiring it all whenever a better model comes out',
      ],
    },
    after: {
      label: 'With Duet',
      title: 'All of it, already connected, behind a chat.',
      body: 'One subscription covers the models, the tools, the computer, and the hosting. You say what you want in plain language, and Duet keeps everything underneath current, so you stay at the state of the art without having to keep up with it.',
    },
  },
  train: {
    eyebrow: 'Learns your work',
    titleLead: 'It learns how you work.',
    titleTrail: 'And gets better every week.',
    intro:
      'Give it your files, your tone, and your tools, and it stops answering like a stranger. Everything it learns stays with it, and with you.',
    feed: ['your files', 'your tone', 'your tools', 'your data', 'your memory', 'your workflows'],
    facetNotes: [
      'Reads straight from your docs, the Acme thread, the pricing deck, instead of starting from a blank page.',
      'Writes the way you write: your phrasing and rhythm, none of the corporate filler.',
      'Knows the tools you live in, so its answer lands where the work already happens.',
      'Reaches into your live data for real specifics, not a hedged, generic guess.',
      'Remembers your past sessions and decisions, so it picks up where you left off instead of starting cold.',
      'Learns the plays you run and walks them end to end, so the repeatable work just happens.',
    ],
  },
  platform: {
    eyebrow: 'What comes with it',
    title: 'Everything built in.',
    intro:
      'Every piece a state-of-the-art agent needs comes with the subscription, already set up. You never pick a vendor, a plan, or a model.',
    primitives: {
      models: {
        title: 'Always the best model',
        body: 'The newest models for writing, images, video, and voice. Duet picks the strongest one for each task and moves to a better one when it arrives, so you never have to choose.',
      },
      computer: {
        title: 'Works while you sleep',
        body: 'Your agents have a computer of their own that never turns off. Close your laptop and the work keeps going.',
      },
      browser: {
        title: 'Uses the web like you do',
        body: 'It clicks, types, signs in, and gets things done on real websites: filling forms, pulling reports, running the errand. Watch it work, or take over at any time.',
      },
      install: {
        title: 'Uses the apps a person would',
        body: 'It has a whole computer, so it can install and use what a new hire would, like WhatsApp or Slack, whenever the job calls for it.',
      },
      services: {
        title: 'Research built in',
        body: 'Find people and companies, look up contact details, and check search rankings and social profiles, with no extra accounts to open.',
      },
      agents: {
        title: 'Agents that remember',
        body: 'Make as many agents as you like, each with its own instructions and memory. They pick up where they left off, and what they learn belongs to you.',
      },
      workspace: {
        title: 'One shared Drive',
        body: 'Your files live in one place your agents and your people can all reach, and every change shows who made it.',
      },
      schedules: {
        title: 'Runs on a schedule',
        body: 'Agents work every morning, every Friday, or the moment something happens. The report is done before you sit down.',
      },
      apps: {
        title: 'Publishes what it builds',
        body: 'Dashboards, tools, and whole websites go live at a real link the moment they are done. Shipped, not parked in a folder.',
      },
    },
    capstone: {
      title: 'Runs itself',
      body: 'Your agents can set up new agents, schedule their own work, and hand jobs to each other. You describe the outcome, and they work out the rest.',
    },
  },
  share: {
    eyebrow: 'Share',
    title: 'Share anything with anyone.',
    intro:
      'Whatever you make in Duet can go to someone else, and they don’t have to set anything up either.',
    cards: [
      {
        label: 'Agents',
        title: 'Bring your team or clients in',
        body: 'Invite people by email and they talk to your agents too. They can use every agent, but only you decide how each one works.',
      },
      {
        label: 'Files',
        title: 'Send a folder, or a public link',
        body: 'Share a folder for someone to work on with you, or publish it at a link anyone can open and download.',
      },
      {
        label: 'Apps',
        title: 'Put what it built in front of anyone',
        body: 'A page or tool your agent made opens at a real link. Share it with a few people, or give it a web address of its own.',
      },
    ],
  },
  integrations: {
    eyebrow: 'Works with your tools',
    title: 'Works in the apps you already use.',
    intro: 'Connect your accounts once, and your agents can read, write, and act in them.',
    tools: {
      title: 'Your tools connect',
      body: '3,000+ integrations, from Gmail and Slack to Notion and Google Drive, each connected with a click.',
      trail: '+ 3,000 more',
    },
  },
  faq: {
    eyebrow: 'FAQ',
    title: 'Questions people ask first.',
    items: [
      {
        q: 'Do I need to know how to code?',
        a: 'No. You talk to Duet the way you would brief a capable assistant. There is nothing to install, no settings to tune, and no code to read or write.',
      },
      {
        q: 'How is this different from ChatGPT?',
        a: 'ChatGPT answers. Duet’s agents do the work: they use a browser, work in your apps, run on a schedule, and publish what they build. And instead of one company’s models, you get the best of each.',
      },
      {
        q: 'Which AI models do I get?',
        a: `The strongest one for each task, including ${MACHINE.models}, plus the leading models for images, video, and voice. You never pick one; Duet chooses for you.`,
      },
      {
        q: 'What happens when a better model comes out?',
        a: 'You get it. Duet adds new models as they are released and starts using them where they do better, with nothing for you to change.',
      },
      {
        q: 'What does the subscription include?',
        a: 'The models, the research and media tools, the computer your agents run on, and hosting for what they build, paid for from your plan’s monthly credits. No separate bills from AI companies, and no charge per person.',
      },
      {
        q: 'Can I share it with my team or clients?',
        a: 'Yes. Invite anyone by email to work with your agents, share folders, or send a link to something an agent built. Each client can have a workspace of their own, with their data kept apart.',
      },
      {
        q: 'Is my data used to train AI?',
        a: 'No. Your files are never used to train models, and the privacy policy binds the model providers to the same rule.',
      },
      {
        q: 'How do I get started?',
        a: 'Start free with a 7-day trial. Ask for your first piece of work in the first few minutes.',
      },
    ],
  },
  close: {
    eyebrow: 'One subscription, every kind of AI',
    titleLead: 'All of AI,',
    titleMark: 'without the setup.',
    sub: 'Start free with a 7-day trial, and have your first agent working in a few minutes.',
    bullets: ['Start in minutes', '7-day free trial', 'No code, ever'],
  },
  featureList: [
    'The best AI models for writing, images, video, and voice, chosen automatically for each task',
    'Agents that browse the web and get things done on real websites',
    '3,000+ app integrations, including Gmail, Slack, Notion, and Google Drive',
    'Built-in research on people, companies, contact details, search rankings, and social profiles',
    'Agents that remember, learn your work, and run on a schedule',
    'An always-on computer for every workspace',
    'Hosting for the pages, tools, and sites agents build',
    'Sharing agents, files, and apps with anyone',
    'One subscription, with no setup and no code',
  ],
}

const ES: HomeCopy = {
  title: 'Duet: Todo tipo de AI en una sola suscripción, sin configurar nada',
  description:
    'Una suscripción para la mejor AI en texto, imágenes, video y voz, más agentes que navegan, investigan y trabajan en tus apps. Nada que configurar.',
  cta: 'Comenzar gratis',
  hero: {
    lead: 'Una suscripción.',
    trail: 'Todo tipo de AI.',
    sub: 'Texto, imágenes, video y voz con los mejores modelos, más agentes que navegan la web, trabajan en tus apps, investigan personas y empresas, actúan por su cuenta y publican lo que construyen. Nada que instalar, nada que configurar.',
  },
  outcomes: {
    eyebrow: 'Lo que le puedes encargar',
    title: 'Di lo que necesitas. Vuelve y está hecho.',
    intro:
      'Algunas cosas que la gente pide en su primera semana. Cada una es una frase, escrita en lenguaje natural.',
    pillars: [
      {
        title: 'Investiga 40 prospectos en una noche',
        body: 'Encuentra a las personas indicadas en las empresas que nombres, consigue sus datos de contacto y redacta un correo personal para cada una en tu Gmail, listo para que lo envíes.',
      },
      {
        title: 'Convierte la foto de un producto en un anuncio en video',
        body: 'Escribe el guion, crea las tomas a partir de tu foto y agrega la voz. Recibes un anuncio terminado, no una lista de herramientas por probar.',
      },
      {
        title: 'Publica una página de reservas',
        body: 'Diseña la página, escribe el texto y la publica en un enlace real que puedes mandarles a tus clientes esa misma tarde.',
      },
      {
        title: 'Vigila los precios de la competencia cada mañana',
        body: 'Visita sus sitios en un horario fijo, anota lo que cambió desde ayer y te manda un resumen corto antes de que empieces a trabajar.',
      },
      {
        title: 'Mantén tu bandeja de entrada bajo control',
        body: 'Ordena lo que llegó, redacta respuestas con tu estilo y te pregunta antes de enviar cualquier cosa.',
      },
      {
        title: 'Convierte una llamada larga en próximos pasos',
        body: 'Sube la grabación y recibe un resumen, un correo de seguimiento y una lista de tareas con la que tu equipo puede trabajar.',
      },
    ],
  },
  setup: {
    eyebrow: 'Por qué antes hacía falta un ingeniero',
    title: 'La mejor AI no es una app. Es un conjunto de piezas.',
    intro:
      'Para tener todo eso por tu cuenta, tendrías que conectar una docena de productos y mantenerlos funcionando mientras salen modelos nuevos cada mes. Por eso casi todos se quedan en un chatbot.',
    before: {
      label: 'Hacerlo por tu cuenta',
      items: [
        'Cuentas con tres o cuatro empresas de AI, cada una con su propia factura',
        'Una herramienta para imágenes, otra para video, otra para voz',
        'Un servicio de investigación para encontrar personas y empresas',
        'Software para que un agente pueda usar sitios web',
        'Una computadora siempre encendida, para que el trabajo avance de noche',
        'Hosting para todo lo que construya el agente',
        'Volver a conectarlo todo cada vez que sale un modelo mejor',
      ],
    },
    after: {
      label: 'Con Duet',
      title: 'Todo, ya conectado, detrás de un chat.',
      body: 'Una suscripción cubre los modelos, las herramientas, la computadora y el hosting. Tú dices lo que quieres en lenguaje natural, y Duet mantiene todo al día por debajo, para que estés a la vanguardia sin tener que seguirle el paso.',
    },
  },
  train: {
    eyebrow: 'Aprende tu trabajo',
    titleLead: 'Aprende cómo trabajas.',
    titleTrail: 'Y mejora cada semana.',
    intro:
      'Dale tus archivos, tu tono y tus herramientas, y deja de responder como un extraño. Todo lo que aprende se queda con él, y contigo.',
    feed: [
      'tus archivos',
      'tu tono',
      'tus herramientas',
      'tus datos',
      'tu memoria',
      'tus procesos',
    ],
    facetNotes: [
      'Lee directo de tus documentos, el hilo con Acme, la presentación de precios, en lugar de empezar de cero.',
      'Escribe como tú escribes: tus frases y tu ritmo, sin relleno corporativo.',
      'Conoce las herramientas que usas a diario, así que su respuesta llega donde ya sucede el trabajo.',
      'Consulta tus datos en vivo para dar detalles reales, no una suposición genérica.',
      'Recuerda tus sesiones y decisiones pasadas, así que retoma donde lo dejaste en lugar de empezar en frío.',
      'Aprende las jugadas que repites y las ejecuta de principio a fin, así que el trabajo repetitivo simplemente sucede.',
    ],
  },
  platform: {
    eyebrow: 'Lo que trae',
    title: 'Todo incluido.',
    intro:
      'Cada pieza que necesita un agente de vanguardia viene con la suscripción, ya configurada. Nunca eliges un proveedor, un plan ni un modelo.',
    primitives: {
      models: {
        title: 'Siempre el mejor modelo',
        body: 'Los modelos más nuevos para texto, imágenes, video y voz. Duet elige el más fuerte para cada tarea y cambia a uno mejor cuando llega, así que nunca tienes que elegir.',
      },
      computer: {
        title: 'Trabaja mientras duermes',
        body: 'Tus agentes tienen una computadora propia que nunca se apaga. Cierra tu laptop y el trabajo sigue avanzando.',
      },
      browser: {
        title: 'Usa la web como tú',
        body: 'Hace clic, escribe, inicia sesión y resuelve cosas en sitios web reales: llena formularios, descarga reportes, hace el trámite. Míralo trabajar o toma el control cuando quieras.',
      },
      install: {
        title: 'Usa las apps que usaría una persona',
        body: 'Tiene una computadora completa, así que puede instalar y usar lo mismo que alguien nuevo en tu equipo, como WhatsApp o Slack, cuando el trabajo lo pida.',
      },
      services: {
        title: 'Investigación incluida',
        body: 'Encuentra personas y empresas, consigue datos de contacto y revisa posiciones en buscadores y perfiles en redes sociales, sin abrir cuentas extra.',
      },
      agents: {
        title: 'Agentes que recuerdan',
        body: 'Crea todos los agentes que quieras, cada uno con sus instrucciones y su memoria. Retoman donde se quedaron, y lo que aprenden te pertenece.',
      },
      workspace: {
        title: 'Un Drive compartido',
        body: 'Tus archivos viven en un solo lugar al que llegan tus agentes y tu gente, y cada cambio muestra quién lo hizo.',
      },
      schedules: {
        title: 'Trabaja en horario',
        body: 'Los agentes trabajan cada mañana, cada viernes o en cuanto pasa algo. El reporte está listo antes de que te sientes.',
      },
      apps: {
        title: 'Publica lo que construye',
        body: 'Tableros, herramientas y sitios completos quedan en línea en un enlace real en cuanto están listos. Publicados, no guardados en una carpeta.',
      },
    },
    capstone: {
      title: 'Se maneja solo',
      body: 'Tus agentes pueden crear agentes nuevos, programar su propio trabajo y pasarse tareas entre ellos. Tú describes el resultado, y ellos resuelven el resto.',
    },
  },
  share: {
    eyebrow: 'Compartir',
    title: 'Comparte lo que sea con quien sea.',
    intro:
      'Todo lo que haces en Duet puede llegar a otra persona, y tampoco tiene que configurar nada.',
    cards: [
      {
        label: 'Agentes',
        title: 'Suma a tu equipo o a tus clientes',
        body: 'Invita a personas por correo y también hablan con tus agentes. Pueden usar todos los agentes, pero solo tú decides cómo trabaja cada uno.',
      },
      {
        label: 'Archivos',
        title: 'Manda una carpeta o un enlace público',
        body: 'Comparte una carpeta para que alguien trabaje contigo, o publícala en un enlace que cualquiera puede abrir y descargar.',
      },
      {
        label: 'Apps',
        title: 'Muestra lo que construyó a quien sea',
        body: 'Una página o herramienta que hizo tu agente se abre en un enlace real. Compártela con unas cuantas personas o dale su propia dirección web.',
      },
    ],
  },
  integrations: {
    eyebrow: 'Funciona con tus herramientas',
    title: 'Trabaja en las apps que ya usas.',
    intro: 'Conecta tus cuentas una vez, y tus agentes pueden leer, escribir y actuar en ellas.',
    tools: {
      title: 'Tus herramientas se conectan',
      body: 'Más de 3,000 integraciones, de Gmail y Slack a Notion y Google Drive, cada una conectada con un clic.',
      trail: '+ 3,000 más',
    },
  },
  faq: {
    eyebrow: 'Preguntas frecuentes',
    title: 'Lo primero que pregunta la gente.',
    items: [
      {
        q: '¿Necesito saber programar?',
        a: 'No. Le hablas a Duet como le explicarías algo a un buen asistente. No hay nada que instalar, ningún ajuste que afinar y ningún código que leer o escribir.',
      },
      {
        q: '¿En qué se diferencia de ChatGPT?',
        a: 'ChatGPT responde. Los agentes de Duet hacen el trabajo: usan un navegador, trabajan en tus apps, avanzan en un horario y publican lo que construyen. Y en lugar de los modelos de una sola empresa, tienes lo mejor de cada una.',
      },
      {
        q: '¿Qué modelos de AI recibo?',
        a: `El más fuerte para cada tarea, incluidos ${MACHINE.models}, más los mejores modelos de imágenes, video y voz. Nunca eliges uno; Duet elige por ti.`,
      },
      {
        q: '¿Qué pasa cuando sale un modelo mejor?',
        a: 'Lo recibes. Duet agrega modelos nuevos en cuanto salen y empieza a usarlos donde rinden mejor, sin que tengas que cambiar nada.',
      },
      {
        q: '¿Qué incluye la suscripción?',
        a: 'Los modelos, las herramientas de investigación y de medios, la computadora donde trabajan tus agentes y el hosting de lo que construyen, pagados con los créditos mensuales de tu plan. Sin facturas aparte de empresas de AI, y sin cobro por persona.',
      },
      {
        q: '¿Puedo compartirlo con mi equipo o mis clientes?',
        a: 'Sí. Invita a quien quieras por correo a trabajar con tus agentes, comparte carpetas o manda el enlace de algo que construyó un agente. Cada cliente puede tener su propio workspace, con sus datos aparte.',
      },
      {
        q: '¿Usan mis datos para entrenar AI?',
        a: 'No. Tus archivos nunca se usan para entrenar modelos, y la política de privacidad obliga a los proveedores de modelos a cumplir la misma regla.',
      },
      {
        q: '¿Cómo empiezo?',
        a: 'Comienza gratis con una prueba de 7 días. Pide tu primer trabajo en los primeros minutos.',
      },
    ],
  },
  close: {
    eyebrow: 'Una suscripción, todo tipo de AI',
    titleLead: 'Toda la AI,',
    titleMark: 'sin configurar nada.',
    sub: 'Comienza gratis con una prueba de 7 días, y ten tu primer agente trabajando en unos minutos.',
    bullets: ['Empieza en minutos', 'Prueba gratis de 7 días', 'Sin código, nunca'],
  },
  featureList: [
    'Los mejores modelos de AI para texto, imágenes, video y voz, elegidos automáticamente para cada tarea',
    'Agentes que navegan la web y resuelven cosas en sitios reales',
    'Más de 3,000 integraciones con apps, incluidas Gmail, Slack, Notion y Google Drive',
    'Investigación incluida sobre personas, empresas, datos de contacto, buscadores y redes sociales',
    'Agentes que recuerdan, aprenden tu trabajo y avanzan en un horario',
    'Una computadora siempre encendida para cada workspace',
    'Hosting para las páginas, herramientas y sitios que construyen los agentes',
    'Compartir agentes, archivos y apps con quien sea',
    'Una sola suscripción, sin configurar nada y sin código',
  ],
}

export const HOME_COPY: Record<AppLocale, HomeCopy> = { en: EN, 'es-419': ES }
