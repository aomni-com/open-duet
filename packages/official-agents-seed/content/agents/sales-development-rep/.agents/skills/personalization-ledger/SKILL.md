---
name: personalization-ledger
description: Admit, trace, and audit evidence used in outbound personalisation. Use when researching a prospect, choosing a personal hook, drafting a sourced first line, or deciding whether a detail is safe to state.
---

# Personalization Ledger

The ledger is the admission gate for personalisation, not a bibliography added after drafting. `AGENTS.md` defines the campaign files and deliverable; this skill decides whether a researched detail may enter the copy.

## Workflow

1. Create an evidence record immediately after opening a useful source, before writing from it.
2. Split compound observations into separate records. One record supports one fact.
3. Test identity: the source must unambiguously refer to the intended person or company.
4. Test entailment: write the narrowest statement the source directly supports.
5. Classify the record `PERSON`, `COMPANY`, `ROLE`, or `REJECT`.
6. Draft from admitted records, then cite their IDs beside the draft outside the email body.
7. Read the line without the recipient's name and company. If it still fits almost anyone in the persona, it is generic; remove the personal framing.

The audit is complete only when every personal or company-specific clause in every draft maps to one admitted record and every unmapped clause has been removed or rewritten as a question.

## Evidence record

```markdown
### E-### — <short label>
- Subject: <person and company>
- Class: PERSON | COMPANY | ROLE | REJECT
- Source: <exact URL opened>
- Published: <YYYY-MM-DD or unavailable>
- Retrieved: <YYYY-MM-DD>
- Direct support: <the exact fact supported, with a short quote only when wording matters>
- Safe use: <the narrow claim the email may make>
- Limits: <what this source does not establish>
```

## Admission rules

- `PERSON`: sourced activity, words, work, or career facts belonging to the confirmed contact.
- `COMPANY`: sourced company event or fact. It personalises the account, not the individual.
- `ROLE`: relevance based only on the confirmed role. It is useful targeting context but must never be described as research into the person's priorities.
- `REJECT`: ambiguous identity, inaccessible source, search snippet, stale employer match, inferred pain, unsourced claim, or a fact too broad to change the message.

A source homepage is not enough when the fact lives on a specific page. A search result is a lead to open, never evidence. Multiple pages repeating one original announcement count as one fact; prefer the original.

## Draft audit

For each contact, answer in `qa.md`:

```markdown
- Identity confirmed: yes | no
- Personal/company clauses: <clause -> evidence ID>
- Could the opener go unchanged to a peer: yes | no
- Claims beyond the evidence: <none or list>
- Verdict: PASS | PLAIN ROLE OPENER | BLOCK
```

`PASS` requires confirmed identity, complete clause-to-source mapping, and a specific opener. `PLAIN ROLE OPENER` is honest when fit exists but evidence does not. `BLOCK` is mandatory when identity, contact data, or a consequential claim cannot be established.
