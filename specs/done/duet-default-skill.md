# Duet default skill

Shipped 2026-07-20. The `duet` default skill gives agents a durable map from any Duet-platform
task to the public API documentation.

## Purpose

Duet is API-first: ordinary user-facing product capabilities are available through public API
operations, and ordinary product UI is a client of that boundary rather than a separate
business-logic surface. Agents therefore need one reliable entry point for discovering how to act,
whether they run inside a Duet workspace or in an external environment.

The skill is deliberately a navigation layer, not another API reference. The developer docs own
rationale and examples, while `packages/contract` owns published methods, paths, scopes, and wire
schemas. Copying those details into a bundled skill would create a second contract that silently
drifts.

## Why this shape

### Broad invocation follows the platform boundary

The skill's invocation description is authored to cover every task involving Duet, not only
requests that mention APIs or documentation. That breadth is intentional: there is no separate
UI-only business-logic surface for an agent to choose instead. The relevant docs guide supplies
workflow context; the generated endpoint reference supplies exact protocol facts.

### Environment selection reuses the API origin

Workspace agents already know `$DUET_API_URL`, so documentation discovery reuses that environment
signal instead of adding a second VM-delivered configuration value or registry render input. The
authored skill owns the exact mapping and fallback rule; its content contract pins the settled
production and staging outcomes. Page paths remain separate because Markdown cannot expand a shell
variable inside a link.

### A capability map is enough help without becoming documentation

The capability map was chosen over a bare root link to reduce repeated navigation work, especially
for less-common surfaces. The authored skill owns its compact discovery categories, while the docs
route registry owns the current published navigation. The skill explains what kind of answer a
guide owns without copying endpoint inventories or payload examples.

## Invariants

- The invocation description stays broad enough to trigger for every Duet-platform task, and the
  skill remains available to both agent contexts.
- Every action is framed as public-API work; the product UI is never described as a separate
  capability owner.
- The docs application owns public developer prose and reference presentation;
  `packages/contract` owns the shared wire facts. The skill contains discovery prose and page paths,
  never endpoint schemas or payloads.
- Production and staging docs selection derives from recognized API hostnames. Unknown contexts
  do not require injected Duet credentials and fall back to production documentation.
- Authored skill content remains the source for generated bundle bytes. The checked-in generated
  file must exactly match the registry generator; hand-edited embedded content is invalid.
- No compatibility aliases, chat-app organization/channel semantics, migration machinery, or
  deployment choreography belong in this feature.

## Rejected alternatives

- **Port the chat-app skill.** Its users, channels, messages, `actorEmail`, and old `/api/v1`
  surface describe another product contract.
- **Thread a docs URL through workspace provisioning or add a render placeholder.** That expands
  VM and registry seams for a value the existing API hostname already determines in deployed Duet
  environments.
- **Point only to the docs root.** The capability map was preferred so agents can find less-common
  surfaces without repeatedly reconstructing the docs navigation.
- **Use dynamic Markdown links.** Variable interpolation does not occur in Markdown destinations;
  an apparent `$DOCS_ORIGIN` link would be a broken literal.
- **Carry compatibility or migration behavior.** The omitted skill had never shipped in this
  registry, so there was no Duet contract to preserve.

## Divergences discovered while building

The generated registry file had pre-existing quote-format drift from the current code generator.
Regeneration therefore normalized existing embedded strings as well as adding the new skill. The
canonical generator output was kept rather than hand-minimizing a generated diff.

The implementation choices and their audit verdicts are retained in the
[choices ledger](duet-default-skill.choices.md).

## Pointers

- Authored behavior: `packages/skills-registry/skills/duet/SKILL.md`
- Roster, content contract, legacy guards, and bundle ceiling:
  `packages/skills-registry/src/roster.test.ts`
- Generated-content owner: `packages/skills-registry/scripts/generate-embedded-files.ts`
- Bundle rendering and placeholder enforcement: `packages/skills-registry/src/render.ts`
- Docs ownership and published navigation: `apps/docs/README.md` and `apps/docs/lib/docs.ts`
