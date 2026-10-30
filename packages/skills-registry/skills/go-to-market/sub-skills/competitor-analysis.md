# Analyzing a Competitor

Synthesize competitive knowledge into a data-driven SWOT analysis and feature comparison, delivered as a visual executive summary in chat.

## Input

- **Competitor name**: The competitor to analyze
- **Competitive knowledge**: Research summaries, competitor profiles, or conversation context
- **Product context** (required for comparison): If not available, ask the user for key product details before proceeding

## Instructions

### Step 1: Gather Evidence

Check what competitive intelligence is available in conversation context. If insufficient, run targeted WebSearch queries for features, pricing, reviews, and positioning.

### Step 2: Generate SWOT Infographic

Use the media-creation skill (GPT Image 2.5 Flare — default) to generate a SWOT infographic.

**Prompt guidance**: Create a 2x2 SWOT analysis grid for [Competitor Name] vs [Our Product]. Top-left green "Strengths", top-right red "Weaknesses", bottom-left blue "Opportunities", bottom-right orange "Threats". 3 items per quadrant with brief labels. Clean, professional business style.

### Step 3: Deliver Analysis Message

Send a message with the SWOT infographic followed by:

```
## [Competitor] vs [Us] — Competitive Analysis

### SWOT Summary

**Strengths**
- **[Strength]** — [evidence with data] ([Source])
- ...

**Weaknesses**
- **[Weakness]** — [evidence: complaints, gaps, data] ([Source])
- ...

**Opportunities** (external factors favoring them)
- [Opportunity] — [how they could capitalize]
- ...

**Threats** (external factors hurting them)
- [Threat] — [impact on them, opportunity for us]
- ...

### Feature Comparison

| Capability | [Competitor] | [Us] | Notes |
|-----------|:---:|:---:|-------|
| [Feature 1] | ✅ Full | 🟡 Partial | [Key difference] |
| [Feature 2] | ❌ None | ✅ Full | [Our advantage] |
| ... | ... | ... | ... |

### Bottom Line
- **Where we win:** [2-3 bullets with specific evidence]
- **Where they win:** [2-3 bullets with specific evidence]
- **Positioning recommendation:** [2-3 sentences — how to sell against them, grounded in evidence above]
```

Every SWOT item must cite evidence. Feature ratings must reflect actual capability, not marketing claims. Keep the entire message under 500 words (excluding tables).

**Output as a chat message, NOT a saved file.**

## Error Handling

**Insufficient data:** Conduct targeted web searches before analysis.
**No product context:** Ask user for product category, key features, and target market.
