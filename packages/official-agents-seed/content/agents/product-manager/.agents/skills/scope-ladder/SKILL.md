---
name: scope-ladder
description: Turn product fog into a decision-complete slice ladder. Use when an idea is vague, scope changes mid-plan, a slice hides implementation choices, or a spec needs a resumable handoff.
---

# Scope Ladder

Build the ladder from explicit decisions, not polished prose. The done condition is a handoff a fresh implementer can start without inventing an unrecorded product choice.

## Workflow

1. **Separate outcome from solution.** Write who needs a changed outcome, the current failure, and the evidence that would show improvement. Mark the proposed implementation as a candidate until the outcome requires it.

2. **Open the ledgers.** Classify every consequential statement as Decided, Open, Assumption, Delegated, or Rejected. For each Open item, name an owner, the evidence needed, and the slice it blocks. For each Delegated item, bound the implementer's freedom.

3. **Balance scope.** For every addition, record the corresponding cut. If there is no cut, record which constraint is being renegotiated: date, quality, cost, or confidence. Do not silently absorb the addition.

4. **Find seams.** Turn the outcome into the smallest ordered contracts that independently expose evidence. Each slice gets one primary question, one owned interface or artifact, and one acceptance verdict.

5. **Run the invention test.** Imagine a fresh implementer starting each slice. List every choice they must make before code can begin. Move each choice into Decided, Open, or bounded Delegated. Repeat until no silent choice remains.

6. **Write the handoff.** Name current status, the exact next slice, active warnings, and the global checklist. Confirm every slice, decision, and unknown is linked from the main spec.

## Slice card

```markdown
# <NN> — <slice>

## Contract unlocked
<one observable capability>

## Seam and ownership
<module/interface/data shape/artifact and its single owner>

## Evidence and acceptance
<what to run or inspect; binary or measurable verdict>

## Decisions
<resolved choices with rationale; explicitly bounded delegated choices>

## Unknowns
<owner, discovery method, resolve-by point; or "None">

## Firewalls
<non-goals and behavior that must stay green>

## Human feedback
<what feedback would change this slice>
```

## Rules

- "TBD during implementation" is an Open decision and must name its owner and blocking point.
- An empty Unknowns section is allowed only after the invention test finds no unresolved choice; never erase a known gap to make the spec look complete.
- A slice that needs multiple unrelated systems before it can prove anything is not independently verifiable; sharpen or split the seam.
- Order governs the artifact, never disclosure: surface a newly discovered blocker immediately even if its section comes later.
