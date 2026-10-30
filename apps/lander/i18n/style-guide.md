# Duet Spanish i18n style guide

Locale: `es-419` (neutral Latin American Spanish). Default locale: `en`.

- Use neutral `tú/tu`; never use Argentinian `vos`, `laburo`, `che`, or region-specific slang.
- Keep expected SaaS/AI terms when they are clearer in English: AI, workflow, dashboard, CRM, API, Slack, Telegram, LLM, Codex, Claude Code.
- Translate user-facing product copy naturally: workspace → espacio de trabajo; AI hire/coworker → compañero de AI / trabajador de AI depending on context; run your business → operar tu negocio.
- Prefer concise, direct sentences. Avoid literal calques and inflated marketing Spanish.
- Keep English routes stable. Spanish public pages live under `/es`; internal content and message locale stays `es-419`. Product routes belong to the sibling app origin.
- Do not publish Spanish blog/guide URLs unless the MDX body is actually translated. Untranslated English content must not get indexed as a Spanish duplicate.
