# Enriching Leads

Gather solution context and synthesize existing account research (including Crustdata-enriched firmographics) into 3 distinct, actionable sales strategies.

## Input

- **Account/company name**: The target account
- **Existing research** (optional): Firmographics, research summaries, or other account intelligence already gathered
- **Solution context** (optional): If already in conversation, skip gathering it

## Instructions

### Step 1: Gather Solution Context

Check if solution context already exists in the conversation. Look for previous mentions of:

- What the user's product/solution does
- Target personas or ideal customer profiles
- Pain points the solution addresses
- Competitors

**If context is missing or incomplete**, ask the user for the information:

1. **What is your solution/product?** - What does it do? What category? Primary value proposition?
2. **Who are your target personas?** - Job titles, departments, company types
3. **What pain points does your solution address?** - Problems customers face, triggers, business outcomes
4. **Who are your main competitors?** - Direct competitors, alternative approaches, differentiators

Structure the gathered context:

```markdown
## Solution Context

**Solution Name:** [Name]
**Category:** [e.g., Cybersecurity, Data Management, DevOps]

**Value Proposition:**
[1-2 sentences on what the solution does and primary value]

**Target Personas (Priority Order):**

1. [Title/Role] - [Department]
2. [Title/Role] - [Department]
3. [Title/Role] - [Department]

**Key Pain Points Addressed:**

1. [Pain point]
2. [Pain point]
3. [Pain point]

**Key Capabilities:**

- [Capability 1]
- [Capability 2]
- [Capability 3]

**Competitors:**

- [Competitor 1]
- [Competitor 2]

**Differentiators:**

- [What makes the solution unique]
```

### Step 2: Read Existing Research

Gather all available research on the account from conversation or files:

- Crustdata-enriched firmographics (headcount trends, funding, web traffic, job openings)
- Research summaries or reports
- Contact dossiers
- Any other account intelligence

Note: If the firmographics or account research workflows were used with Crustdata, the data will include structured metrics like headcount growth rates, revenue estimates, and web traffic — use these for quantitative evidence in strategies.

### Step 3: Synthesize Findings

Before creating strategies, synthesize the research:

**Extract from Research:**

- High-priority findings and urgency indicators
- Consistent themes or repeated challenges
- Specific data points that quantify pain
- Executive quotes that signal priorities

**Map to Solution:**

- Which solution capabilities address which findings?
- Which personas are most affected by which challenges?
- What competitive differentiation applies to which situations?

### Step 4: Design 3 Distinct Strategies

Create 3 strategies with intentional differentiation:

**Differentiation Requirements:**

- Each strategy targets a DIFFERENT primary value theme from your solution
- Each strategy targets a DIFFERENT persona (or persona pair)
- Each strategy uses DIFFERENT evidence from research

**Strategy Components:**

1. **Strategic Thesis**
   - What specific, timely challenge does this address?
   - Why is your solution uniquely positioned?
   - What's the measurable business outcome?

2. **Supporting Evidence**
   - 1-2 specific findings from research
   - Include data points and source attribution
   - Must be from actual research, not assumptions

3. **Solution Alignment**
   - 2-3 specific capabilities that address the challenge
   - Competitive differentiation for this use case

4. **Conversation Starters**
   - 3-4 questions/statements for sales conversations
   - Reference specific company context
   - Demonstrate understanding of their situation
   - Introduce solution value naturally

5. **Next Step**
   - Specific, actionable recommendation
   - Tied to the evidence and urgency

Use the template at [../templates/sales-strategy.md](../templates/sales-strategy.md) for each strategy.

### Step 5: Prioritize and Number Strategies

Rank strategies by:

1. **Urgency** - Time-sensitive opportunities first
2. **Evidence Strength** - Better-supported strategies higher
3. **Alignment** - Closer solution fit ranks higher

Number strategies 1-3 by priority.

### Step 6: Save and Present

Save the 3 strategy documents and present a summary to the user.

## Example Strategy Differentiation

**For a cloud security solution targeting a healthcare company:**

| Strategy | Value Theme           | Persona           | Evidence Focus              |
| -------- | --------------------- | ----------------- | --------------------------- |
| 1        | Compliance Automation | CISO              | HIPAA audit findings        |
| 2        | Threat Detection      | VP Infrastructure | Recent ransomware in sector |
| 3        | Cloud Visibility      | CTO               | Multi-cloud expansion news  |

## Quality Checklist

Before completing, verify:

- [ ] Solution context is complete (name, value prop, personas, pain points, competitors)
- [ ] All 3 strategies are distinct (different themes, personas, evidence)
- [ ] Each strategy has a clear, specific thesis
- [ ] Supporting evidence comes from actual research (not assumptions)
- [ ] Evidence includes specific data/quotes with sources
- [ ] Solution capabilities are specific, not generic marketing
- [ ] Competitive differentiation is relevant to the specific situation
- [ ] Conversation starters reference company-specific context
- [ ] Next steps are specific and actionable
- [ ] Strategies are numbered by priority

## Common Mistakes to Avoid

**Generic strategies:**

- BAD: "Help them improve security"
- GOOD: "Address the compliance gap exposed in their Q3 audit, specifically around data encryption at rest"

**Unsupported claims:**

- BAD: "They likely have X problem"
- GOOD: "CEO stated in earnings call that X is a top priority"

**Misaligned personas:**

- BAD: Target CFO for a technical security feature
- GOOD: Target CFO for cost reduction, CISO for the security capability

**Weak differentiation:**

- BAD: "We're better than competitors"
- GOOD: "Unlike [competitor], we provide X which addresses their specific need for Y"
