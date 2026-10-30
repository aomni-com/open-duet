---
name: seller-ready-views
description: Assemble fixed ABM Plan and Battlecard deliverables from a source-backed account dossier without inventing seller context.
---

# Seller-ready Views

A view is a stable deliverable over the dossier, not a newly improvised report. Generate only from `evidence.jsonl`, `dossier.md`, and seller context explicitly supplied in `identity.md`. Every factual bullet ends in an evidence id. Write `unfound` or `seller input needed` when an input is absent.

Put `Generated <date>; evidence through <latest retrieval date>` under the title. Regenerate only when evidence or seller context changes.

## ABM Plan

Write `views/abm-plan.md` with exactly these sections:

1. **Strategy & investment** — current strategic focus and investments made in the last year; 100 words maximum.
2. **Announcements** — account announcements and major industry events affecting it; 100 words maximum.
3. **Challenges** — up to three evidenced pressures and their operational or growth impact; 100 words maximum.
4. **Opportunities** — up to three account opportunities, then how the seller may help only when seller context supports it; 150 words maximum.
5. **Competitor insights** — relevant alternatives and products the account is evidenced to use. If product use is not retrieved, write `unfound`; 150 words maximum.
6. **Recommended angle** — one strategy tied to the evidence. If seller capabilities are absent, write `seller input needed` rather than a generic pitch.

Keep observed account facts and seller recommendations visibly separate. Do not turn a market trend into an account initiative.

## Battlecard

Write `views/battlecard.md` with exactly these sections, omitting none:

- **Key pain points** — evidenced account pressures, or `unfound`.
- **Features of interest** — seller capabilities mapped to those pressures; `seller input needed` without product context.
- **Quantitative benefits** — only seller proof supplied in context, never a made-up ROI estimate.
- **Relevant news** — dated events and why each matters for this conversation.
- **Useful testimonial** — only a supplied, source-backed seller testimonial; otherwise `seller input needed`.
- **Departments to target** — evidenced functions implicated by the pressure. A plausible title is a hypothesis, not a named contact.
- **Competitive differentiators** — for each supported competitor: its claim, the seller response, and a source. Without seller positioning, write `seller input needed`.

End with **Questions for the first call**: three to five questions that test gaps or hypotheses. Questions are allowed to go beyond known facts precisely because they are questions; statements are not.

## Publish to the board

After saving a view, read the Account Board README and `PUT` it to `/api/accounts/:id/views/:viewId`. The Markdown in `content` remains the same text as the artifact. The board is a projection and must never become the only copy.
