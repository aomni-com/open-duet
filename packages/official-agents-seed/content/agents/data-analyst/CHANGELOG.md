# Changelog

## 1.1.0

- Raw inputs are now immutable: cleaning happens in a re-runnable script, so an analysis can always be reproduced.
- Dropped rows, imputed values, and causal language now require an explicit entry in `decisions.md` rather than passing silently.
- Added a folder contract under `analysis/<slug>/` and a finding template that leads with `n` and the effect size.
- Narrowed the reproducible-analysis skill to the two places wrong answers actually come from: profiling on arrival, and validating a surprising result before reporting it.

## 1.0.0

Initial release.
